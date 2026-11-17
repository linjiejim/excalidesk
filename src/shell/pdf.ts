// 导出 PDF（docs/specs/20261117-presentation-mode.md D7）：一页幻灯片一张 PDF 页，按放映顺序。
// 每页是 2 倍的栅格图：没有图片的页无损（RGB + FlateDecode），有图片的页用 JPEG（DCTDecode）。
// PDF 自己写（Catalog / Pages / 每页 Page + 内容流 + 图片），不加依赖。
import { exportToCanvas } from "@excalidraw/excalidraw";
import { sessions } from "./actions";
import { boxOf, isCommentLike, type El } from "./elements";
import { t, tErr } from "./i18n";
import { basename, ipc } from "./ipc";
import { isNotesFrame, slidesOf } from "./slides";
import { getState, toast } from "./store";

export type PdfImage = { width: number; height: number; filter: "DCTDecode" | "FlateDecode"; data: Uint8Array };
export type PdfPage = { w: number; h: number; image: PdfImage };

/** PDF 里的文字串：UTF-16BE 十六进制，带 BOM（中文标题也能显示） */
function pdfText(s: string) {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}
const num = (n: number) => String(Math.round(n * 100) / 100);

export function buildPdf(pages: readonly PdfPage[], title: string): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(u);
    len += u.length;
  };
  const offsets: number[] = [];
  const obj = (id: number, dict: string, stream?: Uint8Array) => {
    offsets[id] = len;
    push(`${id} 0 obj\n${dict}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  };
  // 1 Catalog · 2 Pages · 3 Info · 之后每页三个对象：Page、内容流、图片
  const page = (i: number) => 4 + i * 3;
  push("%PDF-1.4\n%âãÏÓ\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${page(i)} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = `D:${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  obj(3, `<< /Title ${pdfText(title)} /Producer (Excalidesk) /CreationDate (${stamp}) >>`);
  pages.forEach((p, i) => {
    const content = enc.encode(`q ${num(p.w)} 0 0 ${num(p.h)} 0 0 cm /Im0 Do Q`);
    obj(page(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.w)} ${num(p.h)}] /Resources << /XObject << /Im0 ${page(i) + 2} 0 R >> >> /Contents ${page(i) + 1} 0 R >>`);
    obj(page(i) + 1, `<< /Length ${content.length} >>`, content);
    const im = p.image;
    obj(page(i) + 2, `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${im.filter} /Length ${im.data.length} >>`, im.data);
  });
  const size = 4 + pages.length * 3;
  const xref = len;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

async function flateImage(canvas: HTMLCanvasElement): Promise<PdfImage> {
  const { width, height } = canvas;
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  // deflate 出来是 zlib 格式，正好是 PDF 的 FlateDecode
  const stream = new Blob([rgb as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return { width, height, filter: "FlateDecode", data: new Uint8Array(await new Response(stream).arrayBuffer()) };
}

async function jpegImage(canvas: HTMLCanvasElement): Promise<PdfImage> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
  if (!blob) throw new Error("JPEG encoding failed");
  return { width: canvas.width, height: canvas.height, filter: "DCTDecode", data: new Uint8Array(await blob.arrayBuffer()) };
}

const MAX_PX = 3840;
/** PDF 页最大 200 英寸 */
const MAX_PT = 14400;
const overlaps = (a: El, f: El) => {
  const b = boxOf(a), c = boxOf(f);
  return b.x < c.x + c.w && b.x + b.w > c.x && b.y < c.y + c.h && b.y + b.h > c.y;
};

/** 把画布渲染成 PDF：有页就一页一张（按放映顺序），没有就整张图一页。批注和备注不进去 */
export async function renderPdf(api: any, title: string, progress?: (i: number, n: number) => void): Promise<{ bytes: Uint8Array; pages: number }> {
  const all = (api.getSceneElements() as El[]).filter((e) => !isCommentLike(e));
  const slides = slidesOf(all);
  const files = api.getFiles();
  const bg = api.getAppState().viewBackgroundColor ?? "#ffffff";
  const notes = new Set(all.filter(isNotesFrame).map((f) => f.id));
  const content = all.filter((e) => !notes.has(e.id) && !notes.has(e.frameId ?? ""));
  // 放映时框里看到的东西：页里的元素，加上压在页上的、不属于别的 frame 的元素。
  // 具体压没压上交给 exportingFrame（Excalidraw 按真实范围算，线和箭头按点）
  const jobs = slides.length
    ? slides.map((sl) => ({ frame: sl.frame as El | null, els: content.filter((e) => !e.frameId || e.frameId === sl.frame.id) }))
    : [{ frame: null as El | null, els: content }];
  const pages: PdfPage[] = [];
  for (const [k, job] of jobs.entries()) {
    progress?.(k + 1, jobs.length);
    let scale = 1;
    const canvas = await exportToCanvas({
      elements: job.els as any,
      appState: { exportBackground: true, viewBackgroundColor: bg, exportWithDarkMode: false } as any,
      files,
      exportPadding: job.frame ? 0 : 32,
      exportingFrame: job.frame as any,
      getDimensions: (w: number, h: number) => {
        scale = Math.min(2, MAX_PX / Math.max(w, h));
        return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
      },
    });
    const hasImage = job.els.some((e) => e.type === "image" && (!job.frame || e.frameId === job.frame.id || overlaps(e, job.frame)));
    const image = hasImage ? await jpegImage(canvas) : await flateImage(canvas);
    const fit = Math.min(1, MAX_PT / (Math.max(canvas.width, canvas.height) / scale));
    pages.push({ w: (canvas.width / scale) * fit, h: (canvas.height / scale) * fit, image });
    // 一页一页地让出线程，别把界面卡死
    await new Promise((r) => setTimeout(r, 0));
  }
  return { bytes: buildPdf(pages, title), pages: pages.length };
}

/** 当前标签的图导出成 PDF */
export async function exportPdf(target?: string) {
  const { active } = getState();
  const s = active ? sessions.get(active) : null;
  if (!s?.api) return;
  if (!(s.api.getSceneElements() as El[]).some((e) => !isCommentLike(e))) {
    toast(t("pdf.empty"));
    return;
  }
  const path = target ?? (await ipc.pickSavePath(basename(s.path), "pdf"));
  if (!path) return;
  try {
    const { bytes } = await renderPdf(s.api, basename(s.path), (i, n) => n > 1 && toast(t("pdf.progress", { i, n })));
    await ipc.writeBytes(path, bytes);
    toast(t("toast.exported", { name: path.split("/").pop()! }));
  } catch (e) {
    toast(t("pdf.failed", { error: tErr(e) }));
  }
}

if (import.meta.env.DEV) (window as any).__pdf = { exportPdf, renderPdf, buildPdf };
