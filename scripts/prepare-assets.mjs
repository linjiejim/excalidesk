// 构建前准备静态资源：
// - Excalidraw 0.18 起字体不再内置，从 node_modules 拷到 public/fonts，App 完全离线
// - 基准和自测用的大图场景（确定性生成）
import { cpSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const fonts = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
if (!existsSync("public/fonts/Excalifont")) {
  cpSync(fonts, "public/fonts", { recursive: true });
  console.log("prepare-assets: copied Excalidraw fonts → public/fonts");
}
if (!existsSync("public/scenes/large.excalidraw")) {
  execFileSync(process.execPath, ["bench/gen-scene.mjs", "public/scenes/large.excalidraw"], { stdio: "inherit" });
}
