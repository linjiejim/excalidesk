export interface ParsedMobileCollabLink {
  kind: "room" | "share";
  id: string;
  key: string;
  serverUrl?: string;
  readOnly: boolean;
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function parseMobileCollabLink(input: string): ParsedMobileCollabLink | null {
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
