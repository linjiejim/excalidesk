import { buildShareUrl, decryptBytes, encryptBytes, generateRoomKey, importRoomKey, normalizeServerUrl } from "./crypto.ts";
import type { CollabBinaryFile, CollabElement } from "./protocol.ts";

export interface ShareSnapshotPayload {
  type: "excalidraw";
  version: 2;
  source: string;
  title?: string;
  elements: readonly CollabElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, CollabBinaryFile>;
}

export interface CreatedShare {
  id: string;
  key: string;
  url: string;
  bytes: number;
}

export interface ServerHealth {
  ok: boolean;
  service?: string;
  e2ee?: boolean;
  rooms?: number;
  peers?: number;
}

export async function createShareSnapshot(
  serverUrl: string,
  scene: {
    title?: string;
    elements: readonly CollabElement[];
    appState?: Record<string, unknown>;
    files?: Record<string, CollabBinaryFile>;
  },
): Promise<CreatedShare> {
  const base = normalizeServerUrl(serverUrl);
  const keyStr = await generateRoomKey();
  const key = await importRoomKey(keyStr);

  const payload: ShareSnapshotPayload = {
    type: "excalidraw",
    version: 2,
    source: "Excalidesk",
    title: scene.title,
    elements: scene.elements,
    appState: scene.appState ?? {},
    files: scene.files ?? {},
  };

  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await encryptBytes(plaintext, key);

  const res = await fetch(`${base}/api/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: ciphertext,
  });
  if (!res.ok) {
    throw new Error(`Share upload failed (${res.status})`);
  }
  const data = (await res.json()) as { id: string; bytes: number };
  return {
    id: data.id,
    key: keyStr,
    url: buildShareUrl(base, data.id, keyStr),
    bytes: data.bytes,
  };
}

export async function fetchShareSnapshot(serverUrl: string, id: string, keyStr: string): Promise<ShareSnapshotPayload> {
  const base = normalizeServerUrl(serverUrl);
  const res = await fetch(`${base}/api/shares/${encodeURIComponent(id)}`);
  if (res.status === 404) throw new Error("share_not_found");
  if (!res.ok) throw new Error(`Share download failed (${res.status})`);

  const ciphertext = new Uint8Array(await res.arrayBuffer());
  const key = await importRoomKey(keyStr);
  const plaintext = await decryptBytes(ciphertext, key);
  return JSON.parse(new TextDecoder().decode(plaintext)) as ShareSnapshotPayload;
}

export async function checkServerHealth(serverUrl: string, timeoutMs = 4000): Promise<ServerHealth> {
  const base = normalizeServerUrl(serverUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    return (await res.json()) as ServerHealth;
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}
