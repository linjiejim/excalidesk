export type CollabStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export type CollabColor = {
  background: string;
  stroke: string;
};

export type CollabPeer = {
  clientId: string;
  username: string;
  color: CollabColor;
  readOnly: boolean;
  isSelf?: boolean;
};

export type CollabPointer = {
  x: number;
  y: number;
  tool: "pointer" | "laser";
};

export type AwarenessPayload = {
  username: string;
  color: CollabColor;
  pointer?: CollabPointer;
  button?: "up" | "down";
  selectedElementIds?: Record<string, true>;
};

export type SceneSyncPayload = {
  title?: string;
  elements: readonly CollabElement[];
  appState?: Record<string, unknown>;
  fileIds?: string[];
};

export type CollabElement = {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  fileId?: string | null;
  [key: string]: unknown;
};

export type CollabBinaryFile = {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
  [key: string]: unknown;
};

export type ServerWireMessage =
  | { type: "joined"; roomId: string; clientId: string; peers: { clientId: string; joinedAt: number; readOnly: boolean }[]; hasSnapshot: boolean }
  | { type: "peer-joined"; peer: { clientId: string; joinedAt: number; readOnly: boolean } }
  | { type: "peer-left"; clientId: string }
  | { type: "request-full-scene"; targetClientId: string }
  | { type: "sync-scene"; from: string; payload: string; full: boolean }
  | { type: "awareness"; from: string; payload: string }
  | { type: "file-notify"; from: string; fileIds: string[] }
  | { type: "pong" }
  | { type: "error"; code: string };

const PALETTE: CollabColor[] = [
  { background: "#e7f5ff", stroke: "#1971c2" },
  { background: "#ebfbee", stroke: "#2f9e44" },
  { background: "#fff4e6", stroke: "#d9480f" },
  { background: "#f3f0ff", stroke: "#6741d9" },
  { background: "#fff0f6", stroke: "#c2255c" },
  { background: "#e6fcf5", stroke: "#0ca678" },
  { background: "#fff9db", stroke: "#e67700" },
  { background: "#e3fafc", stroke: "#0c8599" },
];

export function colorForClient(clientId: string): CollabColor {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) {
    hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}
