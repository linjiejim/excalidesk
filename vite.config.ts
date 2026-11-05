import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, writeFileSync } from "node:fs";

// 浏览器跑基准时，把结果 POST 到 /__bench，落到 bench/results/
const benchSink = (): Plugin => {
  const handler = (req: any, res: any, next: any) => {
    if (!req.url?.startsWith("/__bench") || req.method !== "POST") return next();
    const env = new URL(req.url, "http://x").searchParams.get("env") ?? "unknown";
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      mkdirSync("bench/results", { recursive: true });
      writeFileSync(`bench/results/${env}-${Math.floor(Date.now() / 1000)}.json`, body);
      res.end("ok");
    });
  };
  return {
    name: "bench-sink",
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
};

export default defineConfig(() => ({
  plugins: [react(), benchSink()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  preview: { port: 4173, strictPort: true },
}));
