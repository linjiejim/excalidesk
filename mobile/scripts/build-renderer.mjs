// 构建 iOS 预览用的离线渲染器：Vite 打包 mobile/renderer（Excalidraw 用仓库根目录那份，和桌面端同版本），
// 再把 Excalidraw 字体拷进去。产物放进原生模块，随 App 打包（podspec 的 resource_bundles）。
// 依赖仓库根目录已经 npm ci 过。用法：node scripts/build-renderer.mjs（在 mobile/ 下）
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, "..");
const repo = resolve(mobile, "..");
const rootModules = resolve(repo, "node_modules");
const outDir = resolve(mobile, "modules/excalidesk-native/ios/renderer");

if (!existsSync(resolve(rootModules, "@excalidraw/excalidraw"))) {
  console.error("build-renderer: run `npm ci` in the repository root first (Excalidraw comes from there).");
  process.exit(1);
}

const { build } = await import(resolve(rootModules, "vite/dist/node/index.js"));

rmSync(outDir, { recursive: true, force: true });
await build({
  configFile: false,
  root: resolve(mobile, "renderer"),
  base: "./",
  logLevel: "warn",
  resolve: {
    // 渲染器只用仓库根目录的 React（Excalidraw 的 peer），别拿到 mobile/node_modules 里 React Native 那份
    alias: {
      react: resolve(rootModules, "react"),
      "react-dom": resolve(rootModules, "react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir,
    emptyOutDir: true,
    target: "safari17",
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
  },
});

cpSync(resolve(rootModules, "@excalidraw/excalidraw/dist/prod/fonts"), resolve(outDir, "fonts"), { recursive: true });
console.log(`build-renderer: ${outDir}`);
