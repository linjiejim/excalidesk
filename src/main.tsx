import ReactDOM from "react-dom/client";
import BenchApp from "./bench/BenchApp";
import Shell from "./shell/Shell";
import CollabWebApp, { resolveWebCollabLink } from "./web/CollabWebApp";

// 字体走本地（public/fonts），不走 CDN
(window as any).EXCALIDRAW_ASSET_PATH = "/";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const bench = new URLSearchParams(location.search).get("bench") === "1";
const inTauri = "__TAURI_INTERNALS__" in window;

async function start() {
  if (bench) {
    root.render(<BenchApp />);
    return;
  }
  if (!inTauri) {
    const collabLink = await resolveWebCollabLink();
    if (collabLink) {
      root.render(<CollabWebApp initialLink={collabLink} />);
      return;
    }
  }
  // 不用 StrictMode：会把 effect 跑两遍，基准和文档会话都只能初始化一次
  root.render(<Shell />);
}

void start();
