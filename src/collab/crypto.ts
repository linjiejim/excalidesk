// End-to-end encryption (AES-GCM-128) using the standard Web Crypto API.
// Decryption keys live exclusively in URL hash fragments (#room=id,key or #share=id,key)
// and are never transmitted to the collaboration server.

const IV_BYTES = 12;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str: string): Uint8Array<ArrayBuffer> {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export async function generateRoomKey(): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return toBase64Url(raw);
}

export async function importRoomKey(keyStr: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyStr);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: raw.byteLength * 8 }, false, ["encrypt", "decrypt"]);
}

export async function encryptBytes(plaintext: Uint8Array, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(iv);
  const copy = new Uint8Array(new ArrayBuffer(plaintext.byteLength));
  copy.set(plaintext);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, copy));
  const out = new Uint8Array(new ArrayBuffer(IV_BYTES + cipher.byteLength));
  out.set(iv, 0);
  out.set(cipher, IV_BYTES);
  return out;
}

export async function decryptBytes(blob: Uint8Array, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.byteLength <= IV_BYTES) throw new Error("Invalid encrypted payload");
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  iv.set(blob.subarray(0, IV_BYTES));
  const cipherLen = blob.byteLength - IV_BYTES;
  const cipher = new Uint8Array(new ArrayBuffer(cipherLen));
  cipher.set(blob.subarray(IV_BYTES));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new Uint8Array(plain);
}

export async function encryptJson(value: unknown, key: CryptoKey): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await encryptBytes(encoded, key);
  return toBase64Url(encrypted);
}

export async function decryptJson<T = unknown>(encoded: string, key: CryptoKey): Promise<T> {
  const plain = await decryptBytes(fromBase64Url(encoded), key);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function wsUrlFromServer(serverUrl: string): string {
  const clean = normalizeServerUrl(serverUrl);
  if (clean.startsWith("https://")) return `wss://${clean.slice(8)}/ws`;
  if (clean.startsWith("http://")) return `ws://${clean.slice(7)}/ws`;
  if (clean.startsWith("wss://") || clean.startsWith("ws://")) return clean.endsWith("/ws") ? clean : `${clean}/ws`;
  return `wss://${clean}/ws`;
}

export function buildRoomUrl(serverUrl: string, roomId: string, key: string, opts?: { readOnly?: boolean }): string {
  const base = normalizeServerUrl(serverUrl);
  const suffix = opts?.readOnly ? "&ro=1" : "";
  return `${base}/#room=${encodeURIComponent(roomId)},${encodeURIComponent(key)}${suffix}`;
}

export function buildShareUrl(serverUrl: string, shareId: string, key: string): string {
  const base = normalizeServerUrl(serverUrl);
  return `${base}/#share=${encodeURIComponent(shareId)},${encodeURIComponent(key)}`;
}

export type ParsedCollabLink = {
  kind: "room" | "share";
  id: string;
  key: string;
  serverUrl?: string;
  readOnly?: boolean;
};

/**
 * Parses either a full URL (https://host/#room=id,key) or a raw hash (#room=id,key / #share=id,key).
 */
export function parseCollabLink(input: string): ParsedCollabLink | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let hash = "";
  let serverUrl: string | undefined;

  if (trimmed.startsWith("#")) {
    hash = trimmed.slice(1);
  } else {
    try {
      const u = new URL(trimmed);
      hash = u.hash.replace(/^#/, "");
      if (u.protocol === "http:" || u.protocol === "https:") {
        serverUrl = `${u.protocol}//${u.host}`;
      } else {
        const s = u.searchParams.get("server");
        if (s) serverUrl = normalizeServerUrl(s);
      }
    } catch {
      hash = trimmed.replace(/^#/, "");
    }
  }

  if (!hash) return null;
  const parts = hash.split("&");
  const primary = parts[0] ?? "";
  const ro = parts.includes("ro=1");

  const roomMatch = primary.match(/^room=([^,]+),(.+)$/);
  if (roomMatch) {
    const id = decodeURIComponent(roomMatch[1]);
    const key = decodeURIComponent(roomMatch[2]);
    if (!id || !key) return null;
    return { kind: "room", id, key, serverUrl, readOnly: ro };
  }

  const shareMatch = primary.match(/^share=([^,]+),(.+)$/);
  if (shareMatch) {
    const id = decodeURIComponent(shareMatch[1]);
    const key = decodeURIComponent(shareMatch[2]);
    if (!id || !key) return null;
    return { kind: "share", id, key, serverUrl, readOnly: true };
  }

  return null;
}
