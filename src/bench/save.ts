// 两种保存链路，跑在同一个引擎上做对比：
// - ours：按 (id, version, versionNonce) 缓存每个元素的 JSON 片段，只重新序列化变了的元素；图片不进正文（Rust 侧按 fileId 缓存）
// - ezStyle：照搬 ExcalidrawZ 的 save stream（整份 {elements, appState, files} → UTF-8 → sha256 → 64KB 分片 base64，分片间 setTimeout(0) 让出主线程）。
//   只模拟 JS 侧开销，不含它的 postMessage 和 Swift 端解析。

type El = { id: string; version: number; versionNonce: number };

export class ElementJsonCache {
  private cache = new Map<string, { v: number; n: number; json: string }>();
  restringified = 0;

  serialize(elements: readonly El[]): string {
    this.restringified = 0;
    const parts = new Array<string>(elements.length);
    for (let i = 0; i < elements.length; i++) {
      const e = elements[i];
      let c = this.cache.get(e.id);
      if (!c || c.v !== e.version || c.n !== e.versionNonce) {
        c = { v: e.version, n: e.versionNonce, json: JSON.stringify(e) };
        this.cache.set(e.id, c);
        this.restringified++;
      }
      parts[i] = c.json;
    }
    return "[" + parts.join(",") + "]";
  }
}

const PERSISTED_APPSTATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "name"] as const;
export const persistedAppState = (appState: Record<string, unknown>) =>
  Object.fromEntries(PERSISTED_APPSTATE.map((k) => [k, appState[k]]));

export function oursBody(cache: ElementJsonCache, elements: readonly El[], appState: Record<string, unknown>) {
  const json = `{"elements":${cache.serialize(elements)},"appState":${JSON.stringify(persistedAppState(appState))}}`;
  return new TextEncoder().encode(json);
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};
const yieldToMainThread = () => new Promise((r) => setTimeout(r, 0));

/** 返回同步阻塞段（stringify + encode）耗时和整段总耗时 */
export async function ezStyleSave(elements: unknown, appState: unknown, files: unknown) {
  const t0 = performance.now();
  const json = JSON.stringify({ elements, appState, files });
  const bytes = new TextEncoder().encode(json);
  const tSync = performance.now() - t0;
  const hash = crypto.subtle ? crypto.subtle.digest("SHA-256", bytes) : Promise.resolve(null);
  let maxChunk = 0;
  for (let off = 0; off < bytes.length; ) {
    const c0 = performance.now();
    const end = Math.min(off + 65536, bytes.length);
    bytesToBase64(bytes.subarray(off, end));
    maxChunk = Math.max(maxChunk, performance.now() - c0);
    off = end;
    await yieldToMainThread();
  }
  await hash;
  return { syncMs: tSync, totalMs: performance.now() - t0, bytes: bytes.length, maxChunkMs: maxChunk };
}
