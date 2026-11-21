import {
  buildRoomUrl,
  decryptBytes,
  decryptJson,
  encryptBytes,
  encryptJson,
  importRoomKey,
  normalizeServerUrl,
  randomId,
  wsUrlFromServer,
} from "./crypto.ts";
import {
  colorForClient,
  type AwarenessPayload,
  type CollabBinaryFile,
  type CollabElement,
  type CollabPeer,
  type CollabPointer,
  type CollabStatus,
  type SceneSyncPayload,
  type ServerWireMessage,
} from "./protocol.ts";

export interface CollabClientOptions {
  serverUrl: string;
  roomId: string;
  roomKey: string;
  username: string;
  readOnly?: boolean;
  /** True when starting a new room from an existing document (pushes initial snapshot) */
  isHost?: boolean;
  getScene: () => {
    title?: string;
    elements: readonly CollabElement[];
    appState?: Record<string, unknown>;
    files: Record<string, CollabBinaryFile>;
  };
  onRemoteScene: (payload: SceneSyncPayload, fromClientId: string) => void;
  onRemoteFiles: (files: CollabBinaryFile[]) => void;
  onCollaboratorsChange: (collaborators: Map<string, Record<string, unknown>>) => void;
  onPeersChange?: (peers: CollabPeer[]) => void;
  onStatusChange?: (status: CollabStatus, error?: string) => void;
}

const elKey = (e: CollabElement) => `${e.version}:${e.versionNonce}`;

export class CollabClient {
  readonly roomId: string;
  readonly roomKey: string;
  readonly serverUrl: string;
  readonly clientId: string;
  readonly color: { background: string; stroke: string };
  readonly readOnly: boolean;

  private readonly opts: CollabClientOptions;
  private cryptoKey: CryptoKey | null = null;
  private ws: WebSocket | null = null;
  private closed = false;
  private status: CollabStatus = "disconnected";
  private username: string;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sceneTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPointer: { pointer: CollabPointer; button: "up" | "down"; selectedElementIds?: Record<string, true> } | null = null;

  private lastBroadcastVersions = new Map<string, string>();
  private uploadedFiles = new Set<string>();
  private fetchingFiles = new Set<string>();
  private peerMeta = new Map<string, CollabPeer>();
  private collaborators = new Map<string, Record<string, unknown>>();
  private initialLoaded = false;

  constructor(opts: CollabClientOptions) {
    this.opts = opts;
    this.serverUrl = normalizeServerUrl(opts.serverUrl);
    this.roomId = opts.roomId;
    this.roomKey = opts.roomKey;
    this.clientId = `c_${randomId(9)}`;
    this.color = colorForClient(this.clientId);
    this.username = opts.username.trim() || "Guest";
    this.readOnly = Boolean(opts.readOnly);
  }

  get roomUrl(): string {
    return buildRoomUrl(this.serverUrl, this.roomId, this.roomKey);
  }

  get readOnlyUrl(): string {
    return buildRoomUrl(this.serverUrl, this.roomId, this.roomKey, { readOnly: true });
  }

  get currentStatus(): CollabStatus {
    return this.status;
  }

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus("connecting");
    try {
      this.cryptoKey = await importRoomKey(this.roomKey);
    } catch (e) {
      this.setStatus("error", `Invalid encryption key: ${String(e)}`);
      return;
    }
    this.openSocket();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.sceneTimer) clearTimeout(this.sceneTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    if (this.pointerTimer) clearTimeout(this.pointerTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.sceneTimer = null;
    this.snapshotTimer = null;
    this.pointerTimer = null;

    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "leave" }));
        }
        this.ws.close(1000, "Client left");
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.peerMeta.clear();
    this.collaborators.clear();
    this.opts.onCollaboratorsChange(new Map());
    this.opts.onPeersChange?.([]);
    this.setStatus("disconnected");
  }

  setUsername(name: string): void {
    this.username = name.trim() || "Guest";
    const self = this.peerMeta.get(this.clientId);
    if (self) {
      self.username = this.username;
      this.emitPeers();
    }
    void this.sendAwareness({});
  }

  /**
   * Called when local scene changes. Sends only elements whose (version, versionNonce) changed.
   */
  scheduleSceneBroadcast(elements: readonly CollabElement[], files?: Record<string, CollabBinaryFile>): void {
    if (this.readOnly || this.closed) return;
    if (files) void this.uploadNewFiles(files);
    if (this.sceneTimer) return;
    this.sceneTimer = setTimeout(() => {
      this.sceneTimer = null;
      void this.flushSceneDelta(elements);
    }, 55);
    this.scheduleSnapshotUpload();
  }

  /**
   * Marks remote elements as already known so we do not echo them back.
   */
  markElementsKnown(elements: readonly CollabElement[]): void {
    for (const el of elements) {
      this.lastBroadcastVersions.set(el.id, elKey(el));
    }
  }

  /**
   * Throttled pointer/cursor + selection awareness broadcast.
   */
  broadcastPointer(pointer: CollabPointer, button: "up" | "down", selectedElementIds?: Record<string, true>): void {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.pendingPointer = { pointer, button, selectedElementIds };
    if (this.pointerTimer) return;
    this.pointerTimer = setTimeout(() => {
      this.pointerTimer = null;
      const p = this.pendingPointer;
      this.pendingPointer = null;
      if (p) void this.sendAwareness(p);
    }, 48);
  }

  private openSocket(): void {
    if (this.closed) return;
    const url = wsUrlFromServer(this.serverUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws || this.closed) return;
      this.reconnectAttempt = 0;
      ws.send(
        JSON.stringify({
          type: "join",
          roomId: this.roomId,
          clientId: this.clientId,
          readOnly: this.readOnly,
        }),
      );
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 20_000);
    });

    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws || this.closed) return;
      if (typeof ev.data !== "string") return;
      let msg: ServerWireMessage;
      try {
        msg = JSON.parse(ev.data) as ServerWireMessage;
      } catch {
        return;
      }
      void this.handleMessage(msg);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event handles reconnect
    });
  }

  private scheduleReconnect(err?: string): void {
    if (this.closed) return;
    this.reconnectAttempt++;
    const delay = Math.min(15_000, 1000 * Math.pow(1.8, this.reconnectAttempt - 1));
    this.setStatus("reconnecting", err);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private async handleMessage(msg: ServerWireMessage): Promise<void> {
    if (!this.cryptoKey) return;

    switch (msg.type) {
      case "joined": {
        this.setStatus("connected");
        this.peerMeta.clear();
        this.collaborators.clear();
        for (const p of msg.peers) {
          const isSelf = p.clientId === this.clientId;
          const color = colorForClient(p.clientId);
          this.peerMeta.set(p.clientId, {
            clientId: p.clientId,
            username: isSelf ? this.username : "Collaborator",
            color,
            readOnly: p.readOnly,
            isSelf,
          });
          if (!isSelf) {
            this.collaborators.set(p.clientId, {
              id: p.clientId,
              socketId: p.clientId,
              username: "Collaborator",
              color,
            });
          }
        }
        this.emitPeers();
        this.emitCollaborators();
        void this.sendAwareness({});

        const scene = this.opts.getScene();
        if (this.opts.isHost && !this.readOnly && scene.elements.length > 0) {
          this.initialLoaded = true;
          this.markElementsKnown(scene.elements);
          await this.uploadNewFiles(scene.files);
          await this.uploadFullSnapshot();
          if (msg.peers.length > 1) {
            await this.sendFullScene();
          }
        } else if (msg.hasSnapshot && !this.initialLoaded) {
          await this.fetchInitialSnapshot();
        }
        break;
      }

      case "peer-joined": {
        const p = msg.peer;
        const color = colorForClient(p.clientId);
        this.peerMeta.set(p.clientId, {
          clientId: p.clientId,
          username: "Collaborator",
          color,
          readOnly: p.readOnly,
        });
        this.collaborators.set(p.clientId, {
          id: p.clientId,
          socketId: p.clientId,
          username: "Collaborator",
          color,
        });
        this.emitPeers();
        this.emitCollaborators();
        void this.sendAwareness({});
        break;
      }

      case "peer-left": {
        this.peerMeta.delete(msg.clientId);
        this.collaborators.delete(msg.clientId);
        this.emitPeers();
        this.emitCollaborators();
        break;
      }

      case "request-full-scene": {
        if (this.readOnly) return;
        const scene = this.opts.getScene();
        if (scene.elements.length > 0 || Object.keys(scene.files).length > 0) {
          await this.uploadNewFiles(scene.files);
          await this.sendFullScene(msg.targetClientId);
        }
        break;
      }

      case "sync-scene": {
        try {
          const decoded = await decryptJson<SceneSyncPayload>(msg.payload, this.cryptoKey);
          this.initialLoaded = true;
          this.markElementsKnown(decoded.elements);
          this.opts.onRemoteScene(decoded, msg.from);
          const neededFiles = new Set<string>(decoded.fileIds ?? []);
          for (const el of decoded.elements) {
            if (typeof el.fileId === "string" && el.fileId) neededFiles.add(el.fileId);
          }
          if (neededFiles.size > 0) void this.downloadMissingFiles([...neededFiles]);
        } catch {
          // ignore malformed or wrong-key frame
        }
        break;
      }

      case "awareness": {
        try {
          const aw = await decryptJson<AwarenessPayload>(msg.payload, this.cryptoKey);
          const prev = this.peerMeta.get(msg.from);
          const color = aw.color ?? prev?.color ?? colorForClient(msg.from);
          this.peerMeta.set(msg.from, {
            clientId: msg.from,
            username: aw.username || prev?.username || "Collaborator",
            color,
            readOnly: prev?.readOnly ?? false,
          });
          this.collaborators.set(msg.from, {
            id: msg.from,
            socketId: msg.from,
            username: aw.username || "Collaborator",
            color,
            pointer: aw.pointer,
            button: aw.button,
            selectedElementIds: aw.selectedElementIds,
          });
          this.emitPeers();
          this.emitCollaborators();
        } catch {
          // ignore
        }
        break;
      }

      case "file-notify": {
        if (msg.fileIds.length > 0) {
          void this.downloadMissingFiles(msg.fileIds);
        }
        break;
      }

      case "error": {
        this.setStatus("error", msg.code);
        break;
      }
    }
  }

  private async flushSceneDelta(elements: readonly CollabElement[]): Promise<void> {
    if (!this.cryptoKey || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.readOnly) return;
    const changed: CollabElement[] = [];
    for (const el of elements) {
      const k = elKey(el);
      if (this.lastBroadcastVersions.get(el.id) !== k) {
        changed.push(el);
        this.lastBroadcastVersions.set(el.id, k);
      }
    }
    if (!changed.length) return;
    const payload = await encryptJson({ elements: changed } satisfies SceneSyncPayload, this.cryptoKey);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "sync-scene", payload, full: false }));
    }
  }

  async sendFullScene(targetClientId?: string): Promise<void> {
    if (!this.cryptoKey || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.readOnly) return;
    const scene = this.opts.getScene();
    this.markElementsKnown(scene.elements);
    const body: SceneSyncPayload = {
      title: scene.title,
      elements: scene.elements,
      appState: scene.appState,
      fileIds: Object.keys(scene.files),
    };
    const payload = await encryptJson(body, this.cryptoKey);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "sync-scene",
          payload,
          full: true,
          ...(targetClientId ? { targetClientId } : {}),
        }),
      );
    }
  }

  private scheduleSnapshotUpload(): void {
    if (this.readOnly || this.closed) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.uploadFullSnapshot();
    }, 2500);
  }

  private async uploadFullSnapshot(): Promise<void> {
    if (!this.cryptoKey || this.readOnly || this.closed) return;
    const scene = this.opts.getScene();
    const body: SceneSyncPayload = {
      title: scene.title,
      elements: scene.elements,
      appState: scene.appState,
      fileIds: Object.keys(scene.files),
    };
    try {
      const bytes = await encryptBytes(new TextEncoder().encode(JSON.stringify(body)), this.cryptoKey);
      await fetch(`${this.serverUrl}/api/rooms/${encodeURIComponent(this.roomId)}/snapshot`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
    } catch {
      // transient network failure — next edit retries
    }
  }

  private async fetchInitialSnapshot(): Promise<void> {
    if (!this.cryptoKey || this.closed) return;
    try {
      const res = await fetch(`${this.serverUrl}/api/rooms/${encodeURIComponent(this.roomId)}/snapshot`);
      if (!res.ok) return;
      const plain = await decryptBytes(new Uint8Array(await res.arrayBuffer()), this.cryptoKey);
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as SceneSyncPayload;
      this.initialLoaded = true;
      this.markElementsKnown(parsed.elements);
      this.opts.onRemoteScene(parsed, "snapshot");
      const fileIds = new Set<string>(parsed.fileIds ?? []);
      for (const el of parsed.elements) {
        if (typeof el.fileId === "string" && el.fileId) fileIds.add(el.fileId);
      }
      if (fileIds.size > 0) void this.downloadMissingFiles([...fileIds]);
    } catch {
      // ignore
    }
  }

  private async uploadNewFiles(files: Record<string, CollabBinaryFile>): Promise<void> {
    if (!this.cryptoKey || this.readOnly || this.closed) return;
    const newlyUploaded: string[] = [];
    for (const file of Object.values(files)) {
      if (!file?.id || this.uploadedFiles.has(file.id)) continue;
      this.uploadedFiles.add(file.id);
      try {
        const bytes = await encryptBytes(new TextEncoder().encode(JSON.stringify(file)), this.cryptoKey);
        const res = await fetch(
          `${this.serverUrl}/api/rooms/${encodeURIComponent(this.roomId)}/files/${encodeURIComponent(file.id)}`,
          { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
        );
        if (res.ok) newlyUploaded.push(file.id);
        else this.uploadedFiles.delete(file.id);
      } catch {
        this.uploadedFiles.delete(file.id);
      }
    }
    if (newlyUploaded.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "file-notify", fileIds: newlyUploaded }));
    }
  }

  private async downloadMissingFiles(fileIds: string[]): Promise<void> {
    if (!this.cryptoKey || this.closed) return;
    const existing = this.opts.getScene().files;
    const downloaded: CollabBinaryFile[] = [];
    for (const id of fileIds) {
      if (existing[id] || this.fetchingFiles.has(id)) continue;
      this.fetchingFiles.add(id);
      try {
        const res = await fetch(
          `${this.serverUrl}/api/rooms/${encodeURIComponent(this.roomId)}/files/${encodeURIComponent(id)}`,
        );
        if (!res.ok) continue;
        const plain = await decryptBytes(new Uint8Array(await res.arrayBuffer()), this.cryptoKey);
        const file = JSON.parse(new TextDecoder().decode(plain)) as CollabBinaryFile;
        this.uploadedFiles.add(file.id);
        downloaded.push(file);
      } catch {
        // ignore individual file errors
      } finally {
        this.fetchingFiles.delete(id);
      }
    }
    if (downloaded.length > 0) this.opts.onRemoteFiles(downloaded);
  }

  private async sendAwareness(patch: Partial<AwarenessPayload>): Promise<void> {
    if (!this.cryptoKey || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload: AwarenessPayload = {
      username: this.username,
      color: this.color,
      ...patch,
    };
    const encrypted = await encryptJson(payload, this.cryptoKey);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "awareness", payload: encrypted }));
    }
  }

  private setStatus(status: CollabStatus, error?: string): void {
    this.status = status;
    this.opts.onStatusChange?.(status, error);
  }

  private emitPeers(): void {
    this.opts.onPeersChange?.([...this.peerMeta.values()]);
  }

  private emitCollaborators(): void {
    this.opts.onCollaboratorsChange(new Map(this.collaborators));
  }
}
