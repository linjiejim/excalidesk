import ReactDOM from "react-dom/client";
import BenchApp from "./bench/BenchApp";
import Shell from "./shell/Shell";

// 字体走本地（public/fonts），不走 CDN
(window as any).EXCALIDRAW_ASSET_PATH = "/";

const bench = new URLSearchParams(location.search).get("bench") === "1";
// 不用 StrictMode：会把 effect 跑两遍，基准和文档会话都只能初始化一次
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(bench ? <BenchApp /> : <Shell />);
