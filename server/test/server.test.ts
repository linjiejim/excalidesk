import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createExcalideskServer, type ExcalideskServer } from "../src/app.js";

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (predicate(msg)) {
        cleanup();
        resolve(msg);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

describe("Excalidesk Collab & Share Server", () => {
  let tmpDir: string;
  let server: ExcalideskServer;
  let baseUrl: string;
  let wsUrl: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "excalidesk-server-test-"));
    server = createExcalideskServer({
      dataDir: tmpDir,
      maxBodyBytes: 1024 * 1024,
      heartbeatMs: 0,
    });
    const bound = await server.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${bound.port}`;
    wsUrl = `ws://127.0.0.1:${bound.port}/ws`;
  });

  after(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("responds to /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.ok, true);
    assert.equal(json.e2ee, true);
  });

  it("stores and retrieves encrypted share snapshots", async () => {
    const ciphertext = Buffer.from("encrypted-snapshot-bytes-v1");
    const put = await fetch(`${baseUrl}/api/shares`, {
      method: "POST",
      body: ciphertext,
    });
    assert.equal(put.status, 201);
    const { id, bytes } = (await put.json()) as { id: string; bytes: number };
    assert.ok(id.length >= 12);
    assert.equal(bytes, ciphertext.byteLength);

    const get = await fetch(`${baseUrl}/api/shares/${id}`);
    assert.equal(get.status, 200);
    const downloaded = Buffer.from(await get.arrayBuffer());
    assert.deepEqual(downloaded, ciphertext);
  });

  it("rejects invalid IDs and path traversal attempts", async () => {
    const bad = await fetch(`${baseUrl}/api/shares/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(bad.status, 400);
    const missing = await fetch(`${baseUrl}/api/shares/valid_missing_id_12345`);
    assert.equal(missing.status, 404);
  });

  it("stores and retrieves encrypted room snapshots and binary files", async () => {
    const roomId = "room_test_123456";
    const fileId = "file_img_abcdef";
    const snap = Buffer.from("encrypted-room-snapshot");
    const file = Buffer.from("encrypted-png-payload");

    const r1 = await fetch(`${baseUrl}/api/rooms/${roomId}/snapshot`, { method: "PUT", body: snap });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${baseUrl}/api/rooms/${roomId}/snapshot`);
    assert.equal(r2.status, 200);
    assert.deepEqual(Buffer.from(await r2.arrayBuffer()), snap);

    const f1 = await fetch(`${baseUrl}/api/rooms/${roomId}/files/${fileId}`, { method: "PUT", body: file });
    assert.equal(f1.status, 200);
    const f2 = await fetch(`${baseUrl}/api/rooms/${roomId}/files/${fileId}`);
    assert.equal(f2.status, 200);
    assert.deepEqual(Buffer.from(await f2.arrayBuffer()), file);
  });

  it("relays E2EE scene edits, awareness, and requests full scene for late joiners", async () => {
    const roomId = "room_live_987654";
    const wsA = await connectWs(wsUrl);
    const wsB = await connectWs(wsUrl);

    try {
      // Peer A joins first
      const joinedA = waitForMessage(wsA, (m) => m.type === "joined");
      wsA.send(JSON.stringify({ type: "join", roomId, clientId: "client_alpha_1" }));
      const jA = await joinedA;
      assert.equal(jA.peers.length, 1);

      // Peer B joins second -> A should receive peer-joined AND request-full-scene targeting B
      const peerJoinedOnA = waitForMessage(wsA, (m) => m.type === "peer-joined");
      const reqFullOnA = waitForMessage(wsA, (m) => m.type === "request-full-scene");
      const joinedB = waitForMessage(wsB, (m) => m.type === "joined");
      wsB.send(JSON.stringify({ type: "join", roomId, clientId: "client_beta_2" }));

      const [pj, rf, jB] = await Promise.all([peerJoinedOnA, reqFullOnA, joinedB]);
      assert.equal(pj.peer.clientId, "client_beta_2");
      assert.equal(rf.targetClientId, "client_beta_2");
      assert.equal(jB.peers.length, 2);

      // Peer A responds with encrypted full scene targeted to B
      const sceneOnB = waitForMessage(wsB, (m) => m.type === "sync-scene");
      wsA.send(
        JSON.stringify({
          type: "sync-scene",
          payload: "ciphertext-full-scene",
          full: true,
          targetClientId: "client_beta_2",
        }),
      );
      const sB = await sceneOnB;
      assert.equal(sB.from, "client_alpha_1");
      assert.equal(sB.payload, "ciphertext-full-scene");
      assert.equal(sB.full, true);

      // Peer B broadcasts awareness (cursor) to A
      const awarenessOnA = waitForMessage(wsA, (m) => m.type === "awareness");
      wsB.send(JSON.stringify({ type: "awareness", payload: "ciphertext-cursor" }));
      const aA = await awarenessOnA;
      assert.equal(aA.from, "client_beta_2");
      assert.equal(aA.payload, "ciphertext-cursor");

      // Peer B disconnects -> A receives peer-left
      const leftOnA = waitForMessage(wsA, (m) => m.type === "peer-left");
      wsB.close();
      const lA = await leftOnA;
      assert.equal(lA.clientId, "client_beta_2");
    } finally {
      wsA.close();
      wsB.close();
    }
  });

  it("blocks scene mutations from readOnly peers while allowing awareness", async () => {
    const roomId = "room_ro_555555";
    const wsHost = await connectWs(wsUrl);
    const wsViewer = await connectWs(wsUrl);

    try {
      const j1 = waitForMessage(wsHost, (m) => m.type === "joined");
      wsHost.send(JSON.stringify({ type: "join", roomId, clientId: "host_111111" }));
      await j1;

      const j2 = waitForMessage(wsViewer, (m) => m.type === "joined");
      wsViewer.send(JSON.stringify({ type: "join", roomId, clientId: "viewer_222222", readOnly: true }));
      await j2;

      let receivedSceneFromViewer = false;
      wsHost.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "sync-scene") receivedSceneFromViewer = true;
      });

      const awarenessOnHost = waitForMessage(wsHost, (m) => m.type === "awareness");
      wsViewer.send(JSON.stringify({ type: "sync-scene", payload: "should-be-dropped" }));
      wsViewer.send(JSON.stringify({ type: "awareness", payload: "viewer-cursor" }));
      const aw = await awarenessOnHost;
      assert.equal(aw.payload, "viewer-cursor");
      assert.equal(receivedSceneFromViewer, false);
    } finally {
      wsHost.close();
      wsViewer.close();
    }
  });
});
