#!/usr/bin/env node
// 官网截图：用无头 Chrome 打开浏览器版外壳（npm run dev，假数据），让「Claude Code」画一版方案、
// 用户钉两条批注、处理掉一条，再按 中/英 × 浅/深 各截一张，转成 webp 放进 site/screens/。
//
//   npm run dev                         # 另开一个终端，端口 1420
//   node scripts/site-screens.mjs       # 可选：--url http://localhost:1420 --chrome <Chrome 可执行文件>
//
// 最后用 scripts/site-og.html 拼一张分享图 site/og.png（1200×630）。
// 需要 Node 22+、Google Chrome 和 cwebp（brew install webp）。只用 Node 自带的 fetch / WebSocket，不装依赖。
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const URL_BASE = arg("url", "http://localhost:1420");
const CHROME = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "site", "screens");
const PORT = 9339;
const W = 1440, H = 900, SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 画面内容：两版登录页 + 登录流程，一条处理过的批注、一条没处理的 ──
const COPY = {
  zh: {
    file: "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/Excalidraw/产品/App 首页改版.excalidraw",
    a: "方案 A · 密码登录", b: "方案 B · 一键登录", c: "登录流程",
    welcome: "欢迎回来", sub: "登录后继续编辑你的白板", email: "邮箱", password: "密码", signIn: "登录", forgot: "忘记密码？",
    oneStep: "一步进入白板", apple: "通过 Apple 继续", magic: "发送登录链接到邮箱",
    noteMagic: "加一个邮箱链接登录", reply: "已加上，放在 Apple 登录下面", noteLogin: "按钮换成绿色，和品牌色区分开",
    mermaid: "flowchart TD\n  A[打开 App] --> B{已登录?}\n  B -- 是 --> C[最近的白板]\n  B -- 否 --> D[登录页]\n  D --> E[Apple / 邮箱链接]\n  E --> C",
  },
  en: {
    file: "/Users/demo/Library/Mobile Documents/com~apple~CloudDocs/Excalidraw/Product/Home redesign.excalidraw",
    a: "Option A · Password", b: "Option B · One tap", c: "Sign-in flow",
    welcome: "Welcome back", sub: "Sign in to pick up your boards", email: "Email", password: "Password", signIn: "Sign in", forgot: "Forgot password?",
    oneStep: "One tap to your boards", apple: "Continue with Apple", magic: "Email me a sign-in link",
    noteMagic: "Add a passwordless email option", reply: "Added below the Apple button", noteLogin: "Make this button green, not brand violet",
    mermaid: "flowchart TD\n  A[Open the app] --> B{Signed in?}\n  B -- yes --> C[Recent boards]\n  B -- no --> D[Sign-in page]\n  D --> E[Apple / email link]\n  E --> C",
  },
};

// 在页面里执行（序列化成字符串传过去，不能引用外面的变量）
async function demo(c) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__agent; i++) await sleep(100);
  const A = window.__agent;
  const ag = await import("/src/shell/agent.ts");
  const P = c.file;
  await A.openPath(P);
  for (let i = 0; i < 100 && !A.sessions.get(P)?.api; i++) await sleep(100);
  if (!A.sessions.get(P)?.api) throw new Error(`canvas for ${P} never mounted`);
  const agent = "Claude Code";
  const phone = { type: "rectangle", x: 0, y: 0, width: 300, height: 600, strokeColor: "#1e1e1e", backgroundColor: "#ffffff", fillStyle: "solid", roundness: { type: 3 }, order: "back" };
  const field = (y, text) => ({ type: "rectangle", x: 32, y, width: 236, height: 48, roundness: { type: 3 }, strokeColor: "#adb5bd", label: { text, fontSize: 16, textAlign: "left", strokeColor: "#868e96" } });
  await A.op("draw", { path: P, agent, style: "clean", frame: c.a, elements: [
    phone,
    { type: "text", x: 32, y: 72, text: c.welcome, fontSize: 30 },
    { type: "text", x: 32, y: 120, text: c.sub, fontSize: 15, strokeColor: "#868e96" },
    field(180, c.email), field(244, c.password),
    { type: "rectangle", id: "login", x: 32, y: 320, width: 236, height: 52, roundness: { type: 3 }, backgroundColor: "#6965db", fillStyle: "solid", strokeColor: "#6965db", label: { text: c.signIn, fontSize: 18, strokeColor: "#ffffff" } },
    { type: "text", x: 150, y: 400, text: c.forgot, fontSize: 15, strokeColor: "#6965db", textAlign: "center" },
  ] });
  await A.op("draw", { path: P, agent, style: "clean", frame: c.b, elements: [
    phone,
    { type: "ellipse", x: 110, y: 90, width: 80, height: 80, backgroundColor: "#d0bfff", fillStyle: "solid", strokeColor: "#6965db" },
    { type: "text", x: 150, y: 200, text: c.oneStep, fontSize: 24, textAlign: "center" },
    { type: "rectangle", id: "apple", x: 32, y: 320, width: 236, height: 52, roundness: { type: 3 }, backgroundColor: "#1e1e1e", fillStyle: "solid", label: { text: c.apple, fontSize: 17, strokeColor: "#ffffff" } },
    { type: "rectangle", id: "magic", x: 32, y: 388, width: 236, height: 52, roundness: { type: 3 }, label: { text: c.magic, fontSize: 16 } },
  ] });
  const s = A.sessions.get(P);
  const api = s.api;
  const pin = async (id, text) => {
    api.updateScene({ appState: { selectedElementIds: { [id]: true } } });
    await sleep(120);
    ag.startComment(s);
    ag.commitComment(text);
    await sleep(250);
  };
  await pin("magic", c.noteMagic);
  const note = api.getSceneElements().find((e) => e.customData?.excalidesk?.comment?.targets?.[0] === "magic");
  await A.op("resolve", { path: P, agent, comments: [{ id: note.id, reply: c.reply }] });
  await A.op("mermaid", { path: P, agent, frame: c.c, mermaid: c.mermaid });
  await pin("login", c.noteLogin);
  api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} } });
  await sleep(200);
  api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, animate: false });
  await sleep(300);
  // 鼠标别停在画布上（悬停高亮），也别留输入焦点
  document.activeElement?.blur?.();
  return api.getSceneElements().length;
}

// ── CDP ──
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.ok(msg.result);
  };
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const n = ++id;
    pending.set(n, { ok, fail });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  return { send, close: () => ws.close() };
}

async function shoot(lang, theme) {
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem("settings", ${JSON.stringify(JSON.stringify({ theme, lang }))}); localStorage.setItem("sidebarWidth", "248");`,
  });
  await page.send("Page.navigate", { url: URL_BASE });
  const r = await page.send("Runtime.evaluate", { expression: `(${demo})(${JSON.stringify(COPY[lang])})`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${lang}/${theme}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W - 4, y: H - 4 });
  await sleep(1200); // 字体、Mermaid 排版、横幅动画
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  page.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  const dir = join(OUT, lang);
  mkdirSync(dir, { recursive: true });
  const png = join(tmp, `${lang}-${theme}.png`);
  writeFileSync(png, Buffer.from(data, "base64"));
  const out = join(dir, `main-${theme}.webp`);
  execFileSync("cwebp", ["-quiet", "-q", "86", "-resize", String(W * 1.5), "0", png, "-o", out]);
  console.log(`${out}  (${r.result.value} elements)`);
}

// 分享图：模板引用 site/ 里刚生成的截图和图标
async function og() {
  const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 630, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: pathToFileURL(join(HERE, "site-og.html")).href });
  await sleep(1500);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  page.close();
  const out = join(HERE, "..", "site", "og.png");
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(out);
}

const tmp = mkdtempSync(join(tmpdir(), "excalidesk-screens-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(tmp, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
], { stdio: "ignore" });
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(200);
  }
  for (const lang of ["zh", "en"]) for (const theme of ["light", "dark"]) await shoot(lang, theme);
  await og();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await exited;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
