import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExcalideskServer, type ExcalideskServer } from "../server/dist/src/app.js";
import {
  buildRoomUrl,
  buildShareUrl,
  decryptJson,
  encryptJson,
  generateRoomKey,
  importRoomKey,
  parseCollabLink,
  randomId,
} from "../src/collab/crypto.ts";
import { checkServerHealth, createShareSnapshot, fetchShareSnapshot } from "../src/collab/share.ts";
import { CollabClient } from "../src/collab/client.ts";
import type { CollabBinaryFile, CollabElement, CollabPeer, SceneSyncPayload } from "../src/collab/protocol.ts";

function waitUntil(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out waiting for condition"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("Excalidesk E2EE Share & Collab Client E2E", () => {
  let tmpDir: string;
  let server: ExcalideskServer;
  let serverUrl: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "excalidesk-collab-e2e-"));
    server = createExcalideskServer({ dataDir: tmpDir, heartbeatMs: 0 });
    const bound = await server.listen(0, "127.0.0.1");
    serverUrl = `http://127.0.0.1:${bound.port}`;
  });

  after(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("encrypts and decrypts JSON payloads and rejects wrong keys", async () => {
    const key1 = await importRoomKey(await generateRoomKey());
    const key2 = await importRoomKey(await generateRoomKey());
    const sample = { hello: "世界", elements: [{ id: "r1", type: "rectangle" }] };

    const cipher = await encryptJson(sample, key1);
    assert.ok(!cipher.includes("世界"));
    assert.ok(!cipher.includes("rectangle"));

    const plain = await decryptJson<typeof sample>(cipher, key1);
    assert.deepEqual(plain, sample);

    await assert.rejects(() => decryptJson(cipher, key2));
  });

  it("builds and parses room, read-only room, and share links", () => {
    const roomUrl = buildRoomUrl("https://collab.example.com/", "room123456", "keyABCDEF");
    assert.equal(roomUrl, "https://collab.example.com/#room=room123456,keyABCDEF");
    assert.deepEqual(parseCollabLink(roomUrl), {
      kind: "room",
      id: "room123456",
      key: "keyABCDEF",
      serverUrl: "https://collab.example.com",
      readOnly: false,
    });

    const roUrl = buildRoomUrl("https://collab.example.com", "room123456", "keyABCDEF", { readOnly: true });
    assert.equal(parseCollabLink(roUrl)?.readOnly, true);

    const shareUrl = buildShareUrl("http://localhost:3456", "share987654", "keyXYZ");
    assert.deepEqual(parseCollabLink(shareUrl), {
      kind: "share",
      id: "share987654",
      key: "keyXYZ",
      serverUrl: "http://localhost:3456",
      readOnly: true,
    });

    assert.deepEqual(parseCollabLink("#room=abc,def"), {
      kind: "room",
      id: "abc",
      key: "def",
      serverUrl: undefined,
      readOnly: false,
    });
  });

  it("uploads and fetches E2EE share snapshots while server stores only ciphertext", async () => {
    const health = await checkServerHealth(serverUrl);
    assert.equal(health.ok, true);

    const secretText = "TOP_SECRET_ARCHITECTURE_DIAGRAM_42";
    const created = await createShareSnapshot(serverUrl, {
      title: "Architecture",
      elements: [{ id: "t1", type: "text", text: secretText, version: 1, versionNonce: 101 }],
      appState: { viewBackgroundColor: "#ffffff" },
    });

    // Verify raw blob on server does NOT contain plaintext
    const rawBlob = server.storage.getShare(created.id);
    assert.ok(rawBlob);
    assert.equal(rawBlob.toString("utf8").includes(secretText), false);

    // Decrypt using client helper
    const fetched = await fetchShareSnapshot(serverUrl, created.id, created.key);
    assert.equal(fetched.title, "Architecture");
    assert.equal((fetched.elements[0] as any).text, secretText);
  });

  it("syncs initial scene, delta updates, encrypted images, and cursors between Host and Guest", async () => {
    const roomId = `r_${randomId(8)}`;
    const roomKey = await generateRoomKey();

    let hostElements: CollabElement[] = [
      { id: "rect1", type: "rectangle", x: 10, y: 20, width: 100, height: 60, version: 1, versionNonce: 111 },
      { id: "img1", type: "image", fileId: "file_logo_123456", x: 150, y: 20, width: 80, height: 80, version: 1, versionNonce: 222 },
    ];
    const hostFiles: Record<string, CollabBinaryFile> = {
      file_logo_123456: {
        id: "file_logo_123456",
        mimeType: "image/png",
        dataURL: "data:image/png;base64,iVBORw0KGgo=",
      },
    };

    let guestElements: CollabElement[] = [];
    const guestFiles: Record<string, CollabBinaryFile> = {};
    let hostReceivedFromGuest: SceneSyncPayload | null = null;
    let hostCollaborators = new Map<string, Record<string, unknown>>();
    let guestPeers: CollabPeer[] = [];

    const host = new CollabClient({
      serverUrl,
      roomId,
      roomKey,
      username: "Alice",
      isHost: true,
      getScene: () => ({ title: "Design", elements: hostElements, files: hostFiles }),
      onRemoteScene: (payload) => {
        hostReceivedFromGuest = payload;
      },
      onRemoteFiles: () => {},
      onCollaboratorsChange: (c) => {
        hostCollaborators = c;
      },
    });

    const guest = new CollabClient({
      serverUrl,
      roomId,
      roomKey,
      username: "Bob",
      isHost: false,
      getScene: () => ({ elements: guestElements, files: guestFiles }),
      onRemoteScene: (payload) => {
        guestElements = [...payload.elements];
      },
      onRemoteFiles: (files) => {
        for (const f of files) guestFiles[f.id] = f;
      },
      onCollaboratorsChange: () => {},
      onPeersChange: (p) => {
        guestPeers = p;
      },
    });

    try {
      await host.connect();
      await waitUntil(() => host.currentStatus === "connected");

      await guest.connect();
      await waitUntil(() => guestElements.length === 2);
      await waitUntil(() => Boolean(guestFiles.file_logo_123456));
      assert.equal(guestFiles.file_logo_123456.dataURL, hostFiles.file_logo_123456.dataURL);

      // Verify guest sees Alice in peers
      await waitUntil(() => guestPeers.some((p) => p.username === "Alice"));

      // Guest makes an edit and moves cursor
      const newEl: CollabElement = { id: "circle2", type: "ellipse", x: 300, y: 100, width: 50, height: 50, version: 1, versionNonce: 333 };
      guestElements = [...guestElements, newEl];
      guest.scheduleSceneBroadcast(guestElements, guestFiles);
      guest.broadcastPointer({ x: 325, y: 125, tool: "pointer" }, "down");

      await waitUntil(() => hostReceivedFromGuest !== null);
      assert.equal(hostReceivedFromGuest!.elements.length, 1);
      assert.equal(hostReceivedFromGuest!.elements[0].id, "circle2");

      await waitUntil(() => {
        for (const c of hostCollaborators.values()) {
          if (c.username === "Bob" && (c.pointer as any)?.x === 325) return true;
        }
        return false;
      });
    } finally {
      guest.disconnect();
      host.disconnect();
    }
  });
});
