// 桌面外壳的分享链接与多人实时协作管理：把 DocSession 和端到端加密的 CollabClient 接在一起。
import { CollabClient } from "../collab/client";
import { generateRoomKey, normalizeServerUrl, parseCollabLink, randomId } from "../collab/crypto";
import type { CollabBinaryFile, CollabElement, CollabPointer } from "../collab/protocol";
import { createShareSnapshot, fetchShareSnapshot } from "../collab/share";
import { isCommentLike, type El } from "./elements";
import { t } from "./i18n";
import { basename, ipc } from "./ipc";
import type { DocSession } from "./session";
import { getState, setState, toast, type CollabRoomView } from "./store";

const clients = new Map<string, CollabClient>();

const serverUrl = () => normalizeServerUrl(getState().settings.collabServer || "http://localhost:3456");
const displayName = () => getState().settings.collabName.trim() || (getState().lang === "zh" ? "主持人" : "Host");

async function copyText(text: string) {
  await ipc.copyText(text).catch(() => navigator.clipboard?.writeText(text));
}

function setRoomView(path: string, patch: Partial<CollabRoomView> | null) {
  setState((s) => {
    const next = { ...s.collabRooms };
    if (patch === null) {
      delete next[path];
    } else {
      const prev = next[path] ?? { roomId: "", roomUrl: "", readOnlyUrl: "", status: "disconnected" as const, peers: [] };
      next[path] = { ...prev, ...patch };
    }
    return { collabRooms: next };
  });
}

function createClientForSession(
  session: DocSession,
  opts: { serverUrl: string; roomId: string; roomKey: string; isHost: boolean; readOnly?: boolean },
): CollabClient {
  stopCollab(session.path, true);
  const client = new CollabClient({
    serverUrl: opts.serverUrl,
    roomId: opts.roomId,
    roomKey: opts.roomKey,
    username: displayName(),
    isHost: opts.isHost,
    readOnly: opts.readOnly,
    getScene: () => {
      const snap = session.snapshot();
      return {
        title: basename(session.path),
        elements: snap.elements as unknown as CollabElement[],
        appState: {
          viewBackgroundColor: snap.appState.viewBackgroundColor,
          gridSize: snap.appState.gridSize,
          gridModeEnabled: snap.appState.gridModeEnabled,
        },
        files: snap.files as unknown as Record<string, CollabBinaryFile>,
      };
    },
    onRemoteScene: (payload) => {
      session.applyRemoteCollab(payload.elements);
    },
    onRemoteFiles: (files) => {
      session.applyRemoteFiles(files);
    },
    onCollaboratorsChange: (collaborators) => {
      session.applyCollaborators(collaborators);
    },
    onPeersChange: (peers) => {
      setRoomView(session.path, { peers });
    },
    onStatusChange: (status, error) => {
      setRoomView(session.path, { status, error });
    },
  });

  clients.set(session.path, client);
  setRoomView(session.path, {
    roomId: client.roomId,
    roomUrl: client.roomUrl,
    readOnlyUrl: client.readOnlyUrl,
    status: "connecting",
    peers: [],
  });
  return client;
}

/** 为当前文档开启多人实时协作房间，并自动复制链接 */
export async function startCollab(session: DocSession): Promise<string> {
  const roomId = `r_${randomId(10)}`;
  const roomKey = await generateRoomKey();
  const client = createClientForSession(session, {
    serverUrl: serverUrl(),
    roomId,
    roomKey,
    isHost: true,
  });
  await client.connect();
  await copyText(client.roomUrl);
  toast(t("collab.started"));
  return client.roomUrl;
}

/** 通过协作链接或只读分享链接加入房间 / 载入画布 */
export async function joinCollabLink(session: DocSession, rawInput: string): Promise<"room" | "share"> {
  const parsed = parseCollabLink(rawInput);
  if (!parsed) throw new Error(t("collab.invalidLink"));
  const targetServer = parsed.serverUrl || serverUrl();

  if (parsed.kind === "share") {
    const snap = await fetchShareSnapshot(targetServer, parsed.id, parsed.key);
    await session.importSharedScene(snap.elements, snap.files ?? {});
    toast(t("collab.importedShare"));
    return "share";
  }

  const client = createClientForSession(session, {
    serverUrl: targetServer,
    roomId: parsed.id,
    roomKey: parsed.key,
    isHost: false,
    readOnly: parsed.readOnly,
  });
  await client.connect();
  toast(t("collab.joined"));
  return "room";
}

/** 结束某个文档的实时协作 */
export function stopCollab(path: string, silent = false) {
  const client = clients.get(path);
  if (client) {
    client.disconnect();
    clients.delete(path);
  }
  setRoomView(path, null);
  if (!silent && client) toast(t("collab.stopped"));
}

/** 生成端到端加密的只读分享链接并复制 */
export async function createReadOnlyShare(session: DocSession): Promise<{ url: string; bytes: number }> {
  const snap = session.snapshot();
  // 和导出 PNG / SVG 一致：给 Agent 的内部批注不进分享链接
  const elements = snap.elements.filter((e) => !isCommentLike(e as unknown as El)) as unknown as CollabElement[];
  const created = await createShareSnapshot(serverUrl(), {
    title: basename(session.path),
    elements,
    appState: {
      viewBackgroundColor: snap.appState.viewBackgroundColor,
      gridSize: snap.appState.gridSize,
      gridModeEnabled: snap.appState.gridModeEnabled,
    },
    files: snap.files as unknown as Record<string, CollabBinaryFile>,
  });
  await copyText(created.url);
  toast(t("collab.shareCopied"));
  return { url: created.url, bytes: created.bytes };
}

/** 文档发生本地编辑时广播增量（没开协作时是 O(1) 空操作） */
export function notifyCollabScene(path: string, elements: readonly unknown[], files: Record<string, unknown>) {
  const client = clients.get(path);
  if (!client) return;
  client.scheduleSceneBroadcast(
    elements as readonly CollabElement[],
    files as Record<string, CollabBinaryFile>,
  );
}

/** 光标移动时广播实时光标（没开协作时是 O(1) 空操作） */
export function notifyCollabPointer(
  path: string,
  pointer: CollabPointer,
  button: "up" | "down",
  selectedElementIds?: Record<string, true>,
) {
  const client = clients.get(path);
  if (!client) return;
  client.broadcastPointer(pointer, button, selectedElementIds);
}

/** 修改设置里的协作者名称后，同步到所有活跃房间 */
export function syncCollabUsername(name: string) {
  const effective = name.trim() || (getState().lang === "zh" ? "主持人" : "Host");
  for (const client of clients.values()) {
    client.setUsername(effective);
  }
}

/** 重命名文件时迁移协作房间映射 */
export function renameCollabPath(from: string, to: string) {
  const client = clients.get(from);
  if (!client) return;
  clients.delete(from);
  clients.set(to, client);
  setState((s) => {
    const room = s.collabRooms[from];
    if (!room) return {};
    const next = { ...s.collabRooms };
    delete next[from];
    next[to] = room;
    return { collabRooms: next };
  });
}

export function hasActiveCollab(path: string): boolean {
  return clients.has(path);
}
