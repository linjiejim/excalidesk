import { useEffect, useRef, useState } from "react";
import { Excalidraw, restoreElements, CaptureUpdateAction } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { postResults, runBench } from "./bench";

const params = new URLSearchParams(location.search);
const BENCH = params.get("bench") === "1";
const ENV = params.get("env") ?? "browser";

// 手动模式下的帧率表：方便和 ExcalidrawZ 并排凭手感对比
function FpsMeter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let n = 0, last = performance.now(), id = 0;
    const f = (t: number) => {
      n++;
      if (t - last >= 500) { setFps(Math.round((n * 1000) / (t - last))); n = 0; last = t; }
      id = requestAnimationFrame(f);
    };
    id = requestAnimationFrame(f);
    return () => cancelAnimationFrame(id);
  }, []);
  return <div style={{ position: "fixed", right: 8, bottom: 8, zIndex: 10, padding: "2px 8px", borderRadius: 6, background: "#000a", color: "#fff", fontSize: 12 }}>{fps} fps</div>;
}

export default function BenchApp() {
  const [api, setApi] = useState<any>(null);
  const [status, setStatus] = useState("loading");
  const started = useRef(false);

  useEffect(() => {
    if (!api || started.current) return;
    started.current = true;
    if (BENCH) {
      runBench(api, ENV, setStatus)
        .then((out) => postResults(ENV, out))
        .then((where) => setStatus(`done → ${where}`))
        .catch((e) => { setStatus(`error: ${e}`); postResults(ENV, { env: ENV, error: String(e?.stack ?? e) }); });
    } else {
      fetch("/scenes/large.excalidraw").then((r) => r.json()).then((data) => {
        api.addFiles(Object.values(data.files ?? {}));
        const elements = restoreElements(data.elements, null, { repairBindings: true });
        api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
        api.scrollToContent(elements, { fitToContent: true, animate: false });
        setStatus(`${elements.length} elements`);
      });
    }
  }, [api]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={BENCH ? { width: 1280, height: 800, flex: "none", position: "relative" } : { flex: 1, position: "relative" }}>
        <Excalidraw excalidrawAPI={setApi} />
      </div>
      <div id="status" style={{ padding: "4px 10px", fontSize: 12, color: "#555" }}>{ENV} · {status}</div>
      {!BENCH && <FpsMeter />}
    </div>
  );
}
