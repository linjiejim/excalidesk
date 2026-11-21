import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, Excalidraw, reconcileElements, restoreAppState, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { CollabClient } from "../collab/client";
import { generateRoomKey, parseCollabLink, randomId, type ParsedCollabLink } from "../collab/crypto";
import type { CollabBinaryFile, CollabElement, CollabPeer, CollabStatus } from "../collab/protocol";
import { fetchShareSnapshot } from "../collab/share";
import { slidesOf, type Slide } from "../shell/slides";
import "./web.css";

type Lang = "zh" | "en";
const detectLang = (): Lang => (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
const isMobileViewport = () => typeof window !== "undefined" && window.innerWidth < 768;

const LABELS = {
  zh: {
    shared: "只读",
    live: "实时协作",
    connecting: "连接中…",
    connected: "已连接",
    reconnecting: "重连中…",
    error: "连接失败",
    loading: "加载中…",
    notFound: "找不到这个链接，可能已过期。",
    badKey: "无法解密，请确认链接完整。",
    viewMode: "只读",
    editMode: "编辑",
    copyLink: "拷贝链接",
    copied: "已拷贝",
    download: "下载 .excalidraw",
    namePlaceholder: "你的名字",
    e2ee: "端到端加密",
    peers: "{n} 人在线",
    slides: "幻灯片",
    prevSlide: "上一页",
    nextSlide: "下一页",
    fitAll: "全览",
  },
  en: {
    shared: "Read-only",
    live: "Live",
    connecting: "Connecting…",
    connected: "Live",
    reconnecting: "Reconnecting…",
    error: "Connection failed",
    loading: "Loading…",
    notFound: "Link not found or expired.",
    badKey: "Can't decrypt — check the full link.",
    viewMode: "View",
    editMode: "Edit",
    copyLink: "Copy Link",
    copied: "Copied",
    download: "Download .excalidraw",
    namePlaceholder: "Your name",
    e2ee: "End-to-end encrypted",
    peers: "{n} online",
    slides: "Slides",
    prevSlide: "Previous",
    nextSlide: "Next",
    fitAll: "Fit all",
  },
};

export default function CollabWebApp({ initialLink }: { initialLink: ParsedCollabLink }) {
  const lang = useMemo(detectLang, []);
  const L = LABELS[lang];

  const [link] = useState<ParsedCollabLink>(initialLink);
  const serverUrl = useMemo(() => link.serverUrl || window.location.origin, [link.serverUrl]);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const [title, setTitle] = useState<string>(link.kind === "share" ? L.shared : L.live);
  const [status, setStatus] = useState<CollabStatus>(link.kind === "share" ? "connected" : "connecting");
  const [loading, setLoading] = useState<boolean>(link.kind === "share");
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [copied, setCopied] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);
  const [username, setUsername] = useState<string>(
    () => localStorage.getItem("excalidesk.collabName") || (lang === "zh" ? "访客" : "Guest"),
  );
  // Mobile-first: default to clean view mode on mobile screens; desktop can edit immediately unless read-only link
  const [viewOnly, setViewOnly] = useState<boolean>(() => Boolean(link.readOnly) || link.kind === "share" || isMobileViewport());
  const [slides, setSlides] = useState<Slide[]>([]);
  const [slideIdx, setSlideIdx] = useState<number>(-1);
  const [initialData, setInitialData] = useState<{
    elements: readonly CollabElement[];
    appState: Record<string, unknown>;
    files: Record<string, CollabBinaryFile>;
  } | null>(link.kind === "room" ? { elements: [], appState: {}, files: {} } : null);

  const apiRef = useRef<any>(null);
  const clientRef = useRef<CollabClient | null>(null);
  const elementsRef = useRef<readonly CollabElement[]>([]);
  const filesRef = useRef<Record<string, CollabBinaryFile>>({});
  const appStateRef = useRef<Record<string, unknown>>({});
  const applyingRemoteRef = useRef(false);
  const scrolledInitialRef = useRef(false);

  // Share snapshot mode
  useEffect(() => {
    if (link.kind !== "share") return;
    let alive = true;
    setLoading(true);
    setError(null);
    fetchShareSnapshot(serverUrl, link.id, link.key)
      .then((snap) => {
        if (!alive) return;
        const elements = restoreElements((snap.elements ?? []) as any, null, { repairBindings: true }) as unknown as CollabElement[];
        const appState = restoreAppState((snap.appState ?? {}) as any, null) as unknown as Record<string, unknown>;
        const files = (snap.files ?? {}) as Record<string, CollabBinaryFile>;
        elementsRef.current = elements;
        appStateRef.current = appState;
        filesRef.current = files;
        if (snap.title) setTitle(snap.title);
        setSlides(slidesOf(elements as any));
        setInitialData({ elements, appState, files });
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        const msg = String(err);
        setError(msg.includes("share_not_found") ? L.notFound : L.badKey);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [link, serverUrl, L]);

  // Live room collaboration mode
  useEffect(() => {
    if (link.kind !== "room") return;
    const client = new CollabClient({
      serverUrl,
      roomId: link.id,
      roomKey: link.key,
      username,
      readOnly: Boolean(link.readOnly),
      getScene: () => ({
        title,
        elements: (apiRef.current?.getSceneElementsIncludingDeleted() as CollabElement[]) ?? elementsRef.current,
        appState: apiRef.current?.getAppState() ?? appStateRef.current,
        files: (apiRef.current?.getFiles() as Record<string, CollabBinaryFile>) ?? filesRef.current,
      }),
      onRemoteScene: (payload) => {
        if (payload.title) setTitle(payload.title);
        const api = apiRef.current;
        const local = (api?.getSceneElementsIncludingDeleted() as CollabElement[]) ?? elementsRef.current;
        const appState = api?.getAppState() ?? appStateRef.current;
        const incoming = restoreElements(payload.elements as any, null, { repairBindings: true }) as unknown as CollabElement[];
        const merged = reconcileElements(local as any, incoming as any, appState) as unknown as CollabElement[];
        elementsRef.current = merged;
        setSlides(slidesOf(merged as any));
        if (api) {
          applyingRemoteRef.current = true;
          try {
            api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
          } finally {
            applyingRemoteRef.current = false;
          }
          if (!scrolledInitialRef.current && merged.some((e) => !e.isDeleted)) {
            scrolledInitialRef.current = true;
            setTimeout(() => api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 }), 60);
          }
        }
      },
      onRemoteFiles: (files) => {
        const next = { ...filesRef.current };
        for (const f of files) next[f.id] = f;
        filesRef.current = next;
        apiRef.current?.addFiles(files);
      },
      onCollaboratorsChange: (collaborators) => {
        apiRef.current?.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
      },
      onPeersChange: setPeers,
      onStatusChange: (st, err) => {
        setStatus(st);
        if (st === "error" && err) setError(err);
      },
    });
    clientRef.current = client;
    void client.connect();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
    // username changes are pushed via client.setUsername() without reconnecting
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, serverUrl]);

  const onApi = useCallback((api: any) => {
    apiRef.current = api;
    if (elementsRef.current.length > 0 && !scrolledInitialRef.current) {
      scrolledInitialRef.current = true;
      setTimeout(() => api?.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9 }), 80);
    }
  }, []);

  const onChange = useCallback(
    (elements: readonly CollabElement[], appState: Record<string, unknown>, files: Record<string, CollabBinaryFile>) => {
      elementsRef.current = elements;
      appStateRef.current = appState;
      filesRef.current = files;
      setSlides(slidesOf(elements as any));
      if (applyingRemoteRef.current || link.kind !== "room" || link.readOnly) return;
      clientRef.current?.scheduleSceneBroadcast(elements, files);
    },
    [link],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: "pointer" | "laser" }; button: "down" | "up" }) => {
      if (link.kind !== "room") return;
      const sel = apiRef.current?.getAppState()?.selectedElementIds as Record<string, true> | undefined;
      clientRef.current?.broadcastPointer(payload.pointer, payload.button, sel);
    },
    [link.kind],
  );

  const copyCurrentUrl = async () => {
    await navigator.clipboard?.writeText(window.location.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const downloadExcalidraw = () => {
    const els = (apiRef.current?.getSceneElements() as CollabElement[]) ?? elementsRef.current.filter((e) => !e.isDeleted);
    const st = apiRef.current?.getAppState() ?? appStateRef.current;
    const files = apiRef.current?.getFiles() ?? filesRef.current;
    const doc = {
      type: "excalidraw",
      version: 2,
      source: "Excalidesk",
      elements: els,
      appState: {
        viewBackgroundColor: st.viewBackgroundColor ?? "#ffffff",
        gridSize: st.gridSize ?? null,
      },
      files,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/vnd.excalidraw+json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[\\/:*?"<>|]/g, "_") || "drawing"}.excalidraw`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const jumpSlide = (idx: number) => {
    const api = apiRef.current;
    if (!api) return;
    if (idx < 0 || idx >= slides.length) {
      setSlideIdx(-1);
      api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true });
      return;
    }
    setSlideIdx(idx);
    api.scrollToContent([slides[idx].frame], { fitToViewport: true, viewportZoomFactor: 0.92, animate: true });
  };

  const updateName = (next: string) => {
    setUsername(next);
    localStorage.setItem("excalidesk.collabName", next);
    clientRef.current?.setUsername(next);
  };

  const statusText =
    link.kind === "share"
      ? L.shared
      : status === "connected"
        ? L.peers.replace("{n}", String(Math.max(1, peers.length)))
        : status === "reconnecting"
          ? L.reconnecting
          : status === "error"
            ? L.error
            : L.connecting;

  return (
    <div className={`web-collab ${theme}`}>
      <header className="web-bar">
        <div className="web-brand">
          <svg className="web-logo" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="1.5" y="1.5" width="21" height="21" rx="6" className="web-logo-tile" />
            <g className="web-logo-mark">
              <rect x="6.35" y="5" width="3.1" height="13.7" />
              <rect x="9.45" y="5" width="8" height="3.2" />
              <path d="M9.25 11.7 13.05 10.05 16.95 11.7 13.05 13.35Z" />
              <ellipse cx="13.55" cy="16.95" rx="4.1" ry="1.8" />
            </g>
          </svg>
          <b className="web-title">{title}</b>
          <span className={`web-status ${link.kind === "room" ? status : "share"}`}>
            <i />
            {statusText}
          </span>
        </div>

        <div className="web-actions">
          {link.kind === "room" && (
            <button className="web-btn" onClick={() => setNameOpen((v) => !v)} title={username}>
              {username}
            </button>
          )}

          {link.kind === "room" && !link.readOnly && (
            <button className="web-btn" onClick={() => setViewOnly((v) => !v)}>
              {viewOnly ? L.editMode : L.viewMode}
            </button>
          )}

          <button className="web-icon" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} title="Theme">
            {theme === "dark" ? "☀" : "☾"}
          </button>

          <button className="web-icon" onClick={downloadExcalidraw} title={L.download}>
            ↓
          </button>

          <button className="web-btn primary" onClick={() => void copyCurrentUrl()}>
            {copied ? L.copied : L.copyLink}
          </button>
        </div>
      </header>

      {nameOpen && link.kind === "room" && (
        <div className="web-name-pop">
          <input
            value={username}
            placeholder={L.namePlaceholder}
            onChange={(e) => updateName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setNameOpen(false)}
          />
          <div className="web-peer-list">
            {peers.map((p) => (
              <div key={p.clientId} className="web-peer-row">
                <i style={{ background: p.color.stroke }} />
                <span>{p.username}</span>
                {p.isSelf && <span className="web-tag">you</span>}
              </div>
            ))}
          </div>
          <div className="web-e2ee">{L.e2ee}</div>
        </div>
      )}

      <div className="web-canvas">
        {loading ? (
          <div className="web-center">
            <div className="web-spinner" />
            <p>{L.loading}</p>
          </div>
        ) : error ? (
          <div className="web-center">
            <p className="web-err">{error}</p>
          </div>
        ) : initialData ? (
          <Excalidraw
            initialData={initialData as any}
            excalidrawAPI={onApi}
            onChange={onChange as any}
            onPointerUpdate={link.kind === "room" ? onPointerUpdate : undefined}
            isCollaborating={link.kind === "room"}
            viewModeEnabled={viewOnly}
            theme={theme}
            langCode={lang === "zh" ? "zh-CN" : "en"}
            UIOptions={{
              canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false },
            }}
          />
        ) : null}

        {slides.length > 0 && !loading && !error && (
          <div className="web-slides-bar">
            <button onClick={() => jumpSlide(slideIdx <= 0 ? slides.length - 1 : slideIdx - 1)} title={L.prevSlide}>
              ‹
            </button>
            <button onClick={() => jumpSlide(slideIdx < 0 ? 0 : -1)}>
              {slideIdx >= 0 ? `${slideIdx + 1} / ${slides.length}` : `${L.slides} (${slides.length})`}
            </button>
            <button onClick={() => jumpSlide((slideIdx + 1) % slides.length)} title={L.nextSlide}>
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Helper to parse current window location into a collab/share link,
 * or create a fresh room if `#new` is requested.
 */
export async function resolveWebCollabLink(): Promise<ParsedCollabLink | null> {
  if (window.location.hash === "#new") {
    const id = randomId(12);
    const key = await generateRoomKey();
    window.location.replace(`#room=${id},${key}`);
    return { kind: "room", id, key, serverUrl: window.location.origin };
  }
  const parsed = parseCollabLink(window.location.hash);
  if (!parsed) return null;
  return { ...parsed, serverUrl: parsed.serverUrl ?? window.location.origin };
}
