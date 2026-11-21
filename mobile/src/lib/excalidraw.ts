// Pure TypeScript .excalidraw parser, bounds calculator, full-text extractor,
// slide/speaker-notes detector (matching Excalidesk desktop rules), and native thumbnail primitives.

export interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  roughness?: number;
  opacity?: number;
  isDeleted?: boolean;
  points?: [number, number][];
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string | null;
  frameId?: string | null;
  fileId?: string | null;
  name?: string | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  seed?: number;
  roundness?: { type: number; value?: number } | null;
  customData?: {
    excalidesk?: {
      slide?: boolean;
      notesFor?: string;
      comment?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export interface ExcalidrawFile {
  id: string;
  mimeType: string;
  dataURL: string;
}

export interface ExcalidrawScene {
  type?: string;
  version?: number;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, ExcalidrawFile>;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SlideInfo {
  id: string;
  name: string;
  bounds: Bounds;
  notesText: string;
}

export interface SceneSummary {
  liveCount: number;
  slideCount: number;
  imageCount: number;
  backgroundColor: string;
  searchText: string;
  slides: SlideInfo[];
  bounds: Bounds | null;
}

export type ThumbnailPrimitive =
  | { kind: "rect"; x: number; y: number; w: number; h: number; stroke: string; fill: string; rx: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; stroke: string; fill: string }
  | { kind: "polygon"; points: string; stroke: string; fill: string }
  | { kind: "polyline"; points: string; stroke: string }
  | { kind: "frame"; x: number; y: number; w: number; h: number };

const NOTES_NAME = /^\s*(备注|notes)\s*($|[·:：\-—–(（|/])/i;

const ext = (e: ExcalidrawElement) => e.customData?.excalidesk;
const isFrameLike = (e: ExcalidrawElement) => !e.isDeleted && (e.type === "frame" || e.type === "magicframe");
const isCommentLike = (e: ExcalidrawElement) => Boolean(ext(e)?.comment);

export function isNotesFrame(e: ExcalidrawElement): boolean {
  return isFrameLike(e) && !ext(e)?.slide && (Boolean(ext(e)?.notesFor) || NOTES_NAME.test(e.name ?? ""));
}

export function elementBounds(e: ExcalidrawElement): Bounds {
  if ((e.type === "line" || e.type === "arrow" || e.type === "freedraw") && Array.isArray(e.points) && e.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [px, py] of e.points) {
      const gx = e.x + px;
      const gy = e.y + py;
      if (gx < minX) minX = gx;
      if (gy < minY) minY = gy;
      if (gx > maxX) maxX = gx;
      if (gy > maxY) maxY = gy;
    }
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }
  return {
    x: e.x ?? 0,
    y: e.y ?? 0,
    w: Math.max(1, Math.abs(e.width ?? 0)),
    h: Math.max(1, Math.abs(e.height ?? 0)),
  };
}

export function computeSceneBounds(elements: readonly ExcalidrawElement[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const e of elements) {
    if (e.isDeleted) continue;
    const b = elementBounds(e);
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    found = true;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  return found ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } : null;
}

export function parseExcalidrawJson(raw: string): ExcalidrawScene {
  const data = raw.trim() ? JSON.parse(raw) : {};
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid .excalidraw JSON object");
  }
  const elements = Array.isArray(data.elements) ? (data.elements as ExcalidrawElement[]) : [];
  const appState = typeof data.appState === "object" && data.appState !== null ? (data.appState as Record<string, unknown>) : {};
  const files = typeof data.files === "object" && data.files !== null ? (data.files as Record<string, ExcalidrawFile>) : {};
  return {
    type: typeof data.type === "string" ? data.type : "excalidraw",
    version: typeof data.version === "number" ? data.version : 2,
    elements,
    appState,
    files,
  };
}

/** Row-major slide ordering matching Excalidesk desktop (src/shell/slides.ts) */
function orderSlides(frames: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const sorted = [...frames].sort((a, b) => elementBounds(a).y - elementBounds(b).y || elementBounds(a).x - elementBounds(b).x);
  const rows: { top: number; bottom: number; items: ExcalidrawElement[] }[] = [];
  for (const f of sorted) {
    const b = elementBounds(f);
    const row = rows[rows.length - 1];
    const cy = b.y + b.h / 2;
    if (row && cy >= row.top && cy <= row.bottom) {
      row.items.push(f);
      row.bottom = Math.max(row.bottom, b.y + b.h);
    } else {
      rows.push({ top: b.y, bottom: b.y + b.h, items: [f] });
    }
  }
  return rows.flatMap((r) => r.items.sort((a, b) => elementBounds(a).x - elementBounds(b).x || elementBounds(a).y - elementBounds(b).y));
}

function ownerOfNotes(n: ExcalidrawElement, slides: readonly ExcalidrawElement[]): ExcalidrawElement | undefined {
  const nb = elementBounds(n);
  const cx = nb.x + nb.w / 2;
  let best: ExcalidrawElement | undefined;
  let gap = Infinity;
  for (const s of slides) {
    const b = elementBounds(s);
    if (cx < b.x || cx > b.x + b.w || nb.y < b.y + b.h / 2) continue;
    const g = Math.abs(nb.y - (b.y + b.h));
    if (g < gap) {
      best = s;
      gap = g;
    }
  }
  if (best) return best;
  const id = ext(n)?.notesFor;
  return id ? slides.find((s) => s.id === id) : undefined;
}

export function extractSlides(elements: readonly ExcalidrawElement[]): SlideInfo[] {
  const live = elements.filter((e) => !e.isDeleted);
  const frames = live.filter(isFrameLike);
  const slideFrames = orderSlides(frames.filter((f) => !isNotesFrame(f)));
  const noteFrames = frames.filter(isNotesFrame);
  const byId = new Map(live.map((e) => [e.id, e]));
  const notesMap = new Map(slideFrames.map((s) => [s.id, [] as ExcalidrawElement[]]));

  for (const nf of noteFrames) {
    const owner = ownerOfNotes(nf, slideFrames);
    if (owner) notesMap.get(owner.id)!.push(nf);
  }

  const inFrame = (e: ExcalidrawElement, fid: string) =>
    e.frameId === fid || (Boolean(e.containerId) && byId.get(e.containerId!)?.frameId === fid);

  return slideFrames.map((frame, i) => {
    const attached = (notesMap.get(frame.id) ?? []).sort((a, b) => a.y - b.y);
    const notesText = attached
      .map((nf) =>
        live
          .filter((e) => e.type === "text" && !isCommentLike(e) && inFrame(e, nf.id))
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((e) => String(e.originalText ?? e.text ?? "").trim())
          .filter(Boolean)
          .join("\n\n"),
      )
      .filter(Boolean)
      .join("\n\n");

    return {
      id: frame.id,
      name: frame.name?.trim() || `Slide ${i + 1}`,
      bounds: elementBounds(frame),
      notesText,
    };
  });
}

export function summarizeScene(scene: ExcalidrawScene): SceneSummary {
  const live = scene.elements.filter((e) => !e.isDeleted);
  const slides = extractSlides(live);
  const texts: string[] = [];
  let imageCount = 0;

  for (const e of live) {
    if (e.type === "text") {
      const t = String(e.originalText ?? e.text ?? "").trim();
      if (t) texts.push(t);
    } else if (e.type === "frame" || e.type === "magicframe") {
      if (e.name?.trim()) texts.push(e.name.trim());
    } else if (e.type === "image") {
      imageCount++;
    }
  }

  return {
    liveCount: live.length,
    slideCount: slides.length,
    imageCount,
    backgroundColor: typeof scene.appState.viewBackgroundColor === "string" ? scene.appState.viewBackgroundColor : "#ffffff",
    searchText: texts.join(" ").slice(0, 4000),
    slides,
    bounds: computeSceneBounds(live),
  };
}

/**
 * Projects a scene into lightweight normalized SVG primitives (0..100 x 0..64)
 * for instant native thumbnail rendering in the iOS file list.
 */
export function extractThumbnailPrimitives(scene: ExcalidrawScene, maxElements = 120): ThumbnailPrimitive[] {
  const live = scene.elements.filter((e) => !e.isDeleted);
  const bounds = computeSceneBounds(live);
  if (!bounds) return [];

  const viewW = 100;
  const viewH = 64;
  const pad = 6;
  const scale = Math.min((viewW - pad * 2) / bounds.w, (viewH - pad * 2) / bounds.h);
  const offsetX = (viewW - bounds.w * scale) / 2 - bounds.x * scale;
  const offsetY = (viewH - bounds.h * scale) / 2 - bounds.y * scale;
  const sx = (x: number) => Number((x * scale + offsetX).toFixed(1));
  const sy = (y: number) => Number((y * scale + offsetY).toFixed(1));

  const out: ThumbnailPrimitive[] = [];
  const step = Math.max(1, Math.floor(live.length / maxElements));
  for (let i = 0; i < live.length && out.length < maxElements; i += step) {
    const e = live[i];
    const stroke = e.strokeColor && e.strokeColor !== "transparent" ? e.strokeColor : "#495057";
    const fill = e.backgroundColor && e.backgroundColor !== "transparent" ? e.backgroundColor : "none";

    if (e.type === "frame" || e.type === "magicframe") {
      out.push({ kind: "frame", x: sx(e.x), y: sy(e.y), w: Math.max(1, e.width * scale), h: Math.max(1, e.height * scale) });
    } else if (e.type === "rectangle" || e.type === "image") {
      out.push({
        kind: "rect",
        x: sx(e.x),
        y: sy(e.y),
        w: Math.max(1.5, Math.abs(e.width) * scale),
        h: Math.max(1.5, Math.abs(e.height) * scale),
        stroke,
        fill: e.type === "image" ? "#e9ecef" : fill,
        rx: e.roundness ? 2 : 0,
      });
    } else if (e.type === "ellipse") {
      out.push({
        kind: "ellipse",
        cx: sx(e.x + e.width / 2),
        cy: sy(e.y + e.height / 2),
        rx: Math.max(1, (Math.abs(e.width) / 2) * scale),
        ry: Math.max(1, (Math.abs(e.height) / 2) * scale),
        stroke,
        fill,
      });
    } else if (e.type === "diamond") {
      const mx = sx(e.x + e.width / 2);
      const my = sy(e.y + e.height / 2);
      const pts = `${mx},${sy(e.y)} ${sx(e.x + e.width)},${my} ${mx},${sy(e.y + e.height)} ${sx(e.x)},${my}`;
      out.push({ kind: "polygon", points: pts, stroke, fill });
    } else if ((e.type === "line" || e.type === "arrow" || e.type === "freedraw") && Array.isArray(e.points) && e.points.length >= 2) {
      const ptsStep = Math.max(1, Math.floor(e.points.length / 18));
      const pts: string[] = [];
      for (let j = 0; j < e.points.length; j += ptsStep) {
        pts.push(`${sx(e.x + e.points[j][0])},${sy(e.y + e.points[j][1])}`);
      }
      const last = e.points[e.points.length - 1];
      pts.push(`${sx(e.x + last[0])},${sy(e.y + last[1])}`);
      out.push({ kind: "polyline", points: pts.join(" "), stroke });
    } else if (e.type === "text") {
      out.push({
        kind: "rect",
        x: sx(e.x),
        y: sy(e.y + e.height * 0.35),
        w: Math.max(3, Math.abs(e.width) * scale),
        h: Math.max(1.2, Math.min(3, Math.abs(e.height) * scale * 0.35)),
        stroke: "none",
        fill: stroke,
        rx: 0.6,
      });
    }
  }
  return out;
}
