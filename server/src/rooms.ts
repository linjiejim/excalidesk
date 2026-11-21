import type { WebSocket } from "ws";
import { isValidId, type BlobStorage } from "./storage.js";

export interface PeerInfo {
  clientId: string;
  joinedAt: number;
  readOnly: boolean;
}

interface ConnectedPeer {
  ws: WebSocket;
  clientId: string;
  roomId: string;
  joinedAt: number;
  readOnly: boolean;
  alive: boolean;
}

interface ClientMessage {
  type: string;
  roomId?: string;
  clientId?: string;
  readOnly?: boolean;
  payload?: string;
  full?: boolean;
  fileIds?: string[];
  targetClientId?: string;
}

export interface RoomHubOptions {
  storage: BlobStorage;
  maxPeersPerRoom?: number;
  maxMessageBytes?: number;
  heartbeatMs?: number;
}

/**
 * Real-time WebSocket relay hub for end-to-end encrypted Excalidesk rooms.
 * All drawing elements, cursor positions, and usernames arrive as opaque AES-GCM ciphertext strings.
 */
export class RoomHub {
  private readonly rooms = new Map<string, Map<string, ConnectedPeer>>();
  private readonly socketToPeer = new Map<WebSocket, ConnectedPeer>();
  private readonly storage: BlobStorage;
  private readonly maxPeersPerRoom: number;
  private readonly maxMessageBytes: number;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(opts: RoomHubOptions) {
    this.storage = opts.storage;
    this.maxPeersPerRoom = opts.maxPeersPerRoom ?? 64;
    this.maxMessageBytes = opts.maxMessageBytes ?? 4 * 1024 * 1024;
    const heartbeatMs = opts.heartbeatMs ?? 25_000;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.sweepDeadPeers(), heartbeatMs);
      this.heartbeatTimer.unref();
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const ws of this.socketToPeer.keys()) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        // ignore
      }
    }
    this.rooms.clear();
    this.socketToPeer.clear();
  }

  stats(): { rooms: number; peers: number } {
    return { rooms: this.rooms.size, peers: this.socketToPeer.size };
  }

  handleConnection(ws: WebSocket): void {
    ws.on("pong", () => {
      const peer = this.socketToPeer.get(ws);
      if (peer) peer.alive = true;
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (buf.byteLength > this.maxMessageBytes) {
        this.send(ws, { type: "error", code: "message_too_large" });
        return;
      }
      let msg: ClientMessage;
      try {
        msg = JSON.parse(buf.toString("utf8")) as ClientMessage;
      } catch {
        this.send(ws, { type: "error", code: "invalid_json" });
        return;
      }
      this.onMessage(ws, msg);
    });

    ws.on("close", () => this.removeSocket(ws));
    ws.on("error", () => this.removeSocket(ws));
  }

  private onMessage(ws: WebSocket, msg: ClientMessage): void {
    if (msg.type === "ping") {
      const peer = this.socketToPeer.get(ws);
      if (peer) peer.alive = true;
      this.send(ws, { type: "pong" });
      return;
    }

    if (msg.type === "join") {
      const roomId = typeof msg.roomId === "string" ? msg.roomId : "";
      const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
      if (!isValidId(roomId) || !isValidId(clientId)) {
        this.send(ws, { type: "error", code: "invalid_room_or_client" });
        return;
      }
      this.removeSocket(ws);

      let room = this.rooms.get(roomId);
      if (!room) {
        room = new Map();
        this.rooms.set(roomId, room);
      }
      if (!room.has(clientId) && room.size >= this.maxPeersPerRoom) {
        this.send(ws, { type: "error", code: "room_full" });
        return;
      }

      // If same clientId reconnects, replace previous socket cleanly
      const prev = room.get(clientId);
      if (prev && prev.ws !== ws) {
        this.socketToPeer.delete(prev.ws);
        try {
          prev.ws.close(4000, "Replaced by newer connection");
        } catch {
          // ignore
        }
      }

      const peer: ConnectedPeer = {
        ws,
        clientId,
        roomId,
        joinedAt: Date.now(),
        readOnly: Boolean(msg.readOnly),
        alive: true,
      };
      room.set(clientId, peer);
      this.socketToPeer.set(ws, peer);

      const peers: PeerInfo[] = [];
      for (const p of room.values()) {
        peers.push({ clientId: p.clientId, joinedAt: p.joinedAt, readOnly: p.readOnly });
      }

      const hasSnapshot = this.storage.getRoomSnapshot(roomId) !== null;
      this.send(ws, { type: "joined", roomId, clientId, peers, hasSnapshot });

      // Notify existing peers and ask one existing peer to push latest encrypted scene
      let requestedFrom: ConnectedPeer | null = null;
      for (const other of room.values()) {
        if (other.clientId === clientId) continue;
        this.send(other.ws, {
          type: "peer-joined",
          peer: { clientId: peer.clientId, joinedAt: peer.joinedAt, readOnly: peer.readOnly },
        });
        if (!requestedFrom || (!other.readOnly && requestedFrom.readOnly)) {
          requestedFrom = other;
        }
      }
      if (requestedFrom) {
        this.send(requestedFrom.ws, { type: "request-full-scene", targetClientId: clientId });
      }
      return;
    }

    const peer = this.socketToPeer.get(ws);
    if (!peer) {
      this.send(ws, { type: "error", code: "not_joined" });
      return;
    }
    peer.alive = true;
    const room = this.rooms.get(peer.roomId);
    if (!room) return;

    switch (msg.type) {
      case "sync-scene": {
        if (peer.readOnly || typeof msg.payload !== "string") return;
        const out = {
          type: "sync-scene",
          from: peer.clientId,
          payload: msg.payload,
          full: Boolean(msg.full),
        };
        if (typeof msg.targetClientId === "string") {
          const target = room.get(msg.targetClientId);
          if (target && target.clientId !== peer.clientId) this.send(target.ws, out);
        } else {
          this.broadcast(room, peer.clientId, out);
        }
        break;
      }
      case "awareness": {
        if (typeof msg.payload !== "string") return;
        this.broadcast(room, peer.clientId, {
          type: "awareness",
          from: peer.clientId,
          payload: msg.payload,
        });
        break;
      }
      case "file-notify": {
        if (peer.readOnly || !Array.isArray(msg.fileIds)) return;
        const fileIds = msg.fileIds.filter((id): id is string => typeof id === "string" && isValidId(id));
        if (!fileIds.length) return;
        this.broadcast(room, peer.clientId, {
          type: "file-notify",
          from: peer.clientId,
          fileIds,
        });
        break;
      }
      case "leave": {
        this.removeSocket(ws);
        break;
      }
    }
  }

  private removeSocket(ws: WebSocket): void {
    const peer = this.socketToPeer.get(ws);
    if (!peer) return;
    this.socketToPeer.delete(ws);
    const room = this.rooms.get(peer.roomId);
    if (!room) return;
    if (room.get(peer.clientId)?.ws === ws) {
      room.delete(peer.clientId);
      this.broadcast(room, peer.clientId, { type: "peer-left", clientId: peer.clientId });
      if (room.size === 0) this.rooms.delete(peer.roomId);
    }
  }

  private broadcast(room: Map<string, ConnectedPeer>, excludeClientId: string, data: unknown): void {
    const serialized = JSON.stringify(data);
    for (const peer of room.values()) {
      if (peer.clientId === excludeClientId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) {
        peer.ws.send(serialized);
      }
    }
  }

  private send(ws: WebSocket, data: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private sweepDeadPeers(): void {
    for (const [ws, peer] of this.socketToPeer) {
      if (!peer.alive) {
        this.removeSocket(ws);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      peer.alive = false;
      try {
        ws.ping();
      } catch {
        this.removeSocket(ws);
      }
    }
  }
}
