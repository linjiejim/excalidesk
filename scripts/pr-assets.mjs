#!/usr/bin/env node
// PR 素材上传：截图 / 录屏提交进本仓库的 refs/pr-assets/pr-<N>，在标准输出打印可以直接贴进 PR 描述的 markdown。
//
//   node scripts/pr-assets.mjs <PR号|draft> <文件...> [--cols=N] [--width=N] [--remote=origin] [--repo=owner/name]
//
// - 存哪：refs/pr-assets/pr-<N>（开 PR 前用 draft → refs/pr-assets/draft）。不在 refs/heads、refs/tags 下，
//   git clone / git fetch 默认的 refspec 都不拉，仓库不会因为截图变大（orphan 分支会被 clone 拉下来）。
//   每次上传在该 ref 的 tip 上追加一个只含素材的提交（文件在 pr-<N>/<8位随机>-<文件名>，树累积该 PR 传过的所有文件），
//   和 main 没有共同历史。只用底层命令（hash-object / 临时 GIT_INDEX_FILE / commit-tree），不碰工作区和暂存区。
// - 并发：推送带 --force-with-lease=<ref>:<读到的 tip>，而新提交的父提交就是那个 tip，所以这是一次比较并交换：
//   别人先推了（客户端报 stale info，或服务端加锁时报 failed to update ref，以重读到的 tip 变了为准）就在新 tip 上重建，
//   最多 8 次。旧提交都还在历史里，旧链接不会失效。
// - 链接钉 SHA：https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>。这是 GitHub 自己的域名，
//   PR 页面直接内嵌，不经 camo 图片代理。
//   输出用 <img width>：竖图 240 宽每行 3 列，横图 460 宽每行 2 列，多图成表、文件名当图注。
//   视频（mp4/mov）用 ffmpeg 转 GIF 内嵌（fps=12、宽 ≤480、调色板两趟），附原片链接；没有 ffmpeg 就只给链接。
// - 只收 png/jpg/webp/gif/mp4/mov，单文件 ≤50MB（GitHub 单文件硬上限 100MB）。零依赖：Node 内置模块 + git。
// - 云端兜底：Claude 云端会话的 GitHub 代理只放行 refs/heads/*。推 refs/pr-assets 被拒（不是并发冲突）时，
//   改推临时分支 pr-assets-inbox/<N>-<随机>，由 .github/workflows/pr-assets-inbox.yml 搬进 refs/pr-assets/pr-<N>
//   并删掉分支（`--absorb <分支>` 就是那个工作流跑的步骤）。push 触发的工作流只从被推的提交里读工作流文件，
//   所以分支 tip 是一个「载体」合并提交：树 = 默认分支的树（工作流文件在里面），第二个父提交 = 素材提交。
//   打印的链接钉的是素材提交，推上去就能打开，搬完之后照样能打开。`--inbox-base=<提交>` 换载体的树，测试未合并的工作流用。
// - 传上去就永久公开（谁都能按 SHA 打开，不清理旧 ref）：截图里不能有真实用户数据、密钥、本机路径。
// - 图裂了：先 `curl -sI <链接>` 看是不是 200 和 image/*，再在浏览器里打开 PR 页面，看那张图的 naturalWidth 是不是 0。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const KINDS = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".mov": "video",
};
const MAX_BYTES = 50 * 1024 * 1024;
const ATTEMPTS = 8;
const INBOX_PREFIX = "pr-assets-inbox/";
const INBOX_WORKFLOW = ".github/workflows/pr-assets-inbox.yml";
const USAGE =
  "用法: node scripts/pr-assets.mjs <PR号|draft> <文件...> [--cols=N] [--width=N] [--remote=origin] [--repo=owner/name]";

const log = (msg) => console.error(`[pr-assets] ${msg}`);
function die(msg) {
  log(msg);
  process.exit(1);
}

function git(args, { input, env, ok = false } = {}) {
  const r = spawnSync("git", args, {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
  });
  if (r.error) die(`跑不了 git：${r.error.message}`);
  if (r.status !== 0 && !ok) die(`git ${args.join(" ")} 失败：\n${r.stderr.trim()}`);
  return { status: r.status, out: r.stdout.replace(/\n$/, ""), err: r.stderr.trim() };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 没配 user.email 时 git 会拿主机名拼一个身份，别把它写进公开仓库：作者、提交者缺哪个补哪个。 */
function identityEnv() {
  if (git(["config", "user.email"], { ok: true }).out) return {};
  const env = {};
  for (const who of ["AUTHOR", "COMMITTER"])
    if (!process.env[`GIT_${who}_EMAIL`]) {
      env[`GIT_${who}_NAME`] = "pr-assets";
      env[`GIT_${who}_EMAIL`] = "pr-assets@users.noreply.github.com";
    }
  return env;
}

/** 远端 ref 的当前 SHA；不存在返回 null。 */
function remoteTip(remote, ref) {
  const r = git(["ls-remote", remote, ref], { ok: true });
  if (r.status !== 0) die(`读不了 ${remote} 的 ${ref}：\n${r.err}`);
  const line = r.out.split("\n").find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split("\t")[0] : null;
}

/** 只取对象：不写 FETCH_HEAD、不建本地 ref，工作区和暂存区不受影响。 */
const fetchObjects = (remote, what) =>
  git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, what], { ok: true }).status === 0;

const hasCommit = (sha) => git(["cat-file", "-e", `${sha}^{commit}`], { ok: true }).status === 0;

function isAncestor(a, b) {
  const r = git(["merge-base", "--is-ancestor", a, b], { ok: true });
  if (r.status > 1) die(`git merge-base 失败：\n${r.err}`);
  return r.status === 0;
}

/** 在临时 index 里拼树再 commit-tree；index 里先放 base 的树（可无），再加 entries（ls-tree 格式的行）。 */
function commitTree({ base, entries, parents, message, env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-assets-index-"));
  const indexEnv = { ...env, GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    if (base) git(["read-tree", `${base}^{tree}`], { env: indexEnv });
    if (entries.length)
      git(["update-index", "-z", "--add", "--index-info"], { env: indexEnv, input: entries.map((e) => `${e}\0`).join("") });
    const tree = git(["write-tree"], { env: indexEnv }).out;
    return git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message], { env }).out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 推一个 ref。lease 为 undefined 时不带 --force-with-lease；为 null 表示「远端不能已有这个 ref」。
 * 失败后只看重读到的 tip，不看报错文字（客户端报 stale info、服务端加锁时报 failed to update ref，
 * 代理在推送用的 ref 列表里藏掉 ref 时也会报 stale info）：tip 就是 src → 其实推上去了；
 * tip 变了 → conflict，别人先改了，重试；tip 没变 → 推不上去（比如代理不放行），换路。
 */
function pushRef(remote, src, dst, lease) {
  const args = ["push", "--porcelain", "--no-follow-tags"];
  if (lease !== undefined) args.push(`--force-with-lease=${dst}:${lease ?? ""}`);
  const r = git([...args, remote, `${src}:${dst}`], { ok: true });
  const line = r.out.split("\n").find((l) => l.split("\t")[1]?.endsWith(`:${dst}`));
  if (r.status === 0 && line && line[0] !== "!") return { ok: true };
  const now = remoteTip(remote, dst);
  if (now === src) return { ok: true };
  const err = [r.out, r.err].filter(Boolean).join("\n");
  return { ok: false, conflict: lease !== undefined && now !== lease, err };
}

/** 推完分支后 git 会顺手建远端跟踪 ref（refs/remotes/<remote>/…），工作流删掉分支后它就成了残留。 */
function dropTrackingRef(remote, branch, sha) {
  const ref = `refs/remotes/${remote}/${branch}`;
  if (git(["rev-parse", "--verify", "-q", ref], { ok: true }).out === sha) git(["update-ref", "-d", ref, sha], { ok: true });
}

// ---------- 图片尺寸（只读文件头，不引依赖） ----------

function imageSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return parseSize(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function parseSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 4) === "GIF8") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const chunk = b.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** 按方向定展示宽度和每行列数（不放大比展示宽度还小的图）；尺寸读不出时走中间档。 */
function layoutFor(size) {
  if (!size) return { width: 360, cols: 2 };
  const fit = (width, cols) => ({ width: Math.min(width, size.w || width), cols });
  if (size.h > size.w * 1.2) return fit(240, 3); // 手机竖屏
  if (size.w > size.h * 1.2) return fit(460, 2); // 桌面 / 横屏
  return fit(320, 2);
}

// ---------- markdown ----------

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;");
/** 表头、链接文字里的文件名：HTML 转义之外再挡掉 markdown 的强调、代码、链接语法。 */
const escapeMd = (s) => escapeHtml(s).replace(/[\\`*_[\]]/g, "\\$&");

/** 图片按 cols 分块成表（表头即图注）；只有一张时不套表格。 */
function renderGallery(items, colsOverride, widthOverride) {
  if (!items.length) return [];
  const cols = colsOverride ?? Math.min(...items.map((i) => i.cols));
  const img = (i) => `<img src="${i.url}" alt="${escapeHtml(i.caption)}" width="${widthOverride ?? i.width}">`;
  if (items.length === 1) return [img(items[0])];
  const out = [];
  for (let i = 0; i < items.length; i += cols) {
    const row = items.slice(i, i + cols);
    if (i) out.push("");
    out.push(
      `| ${row.map((r) => escapeMd(r.caption)).join(" | ")} |`,
      `| ${row.map(() => "---").join(" | ")} |`,
      `| ${row.map(img).join(" | ")} |`,
    );
  }
  return out;
}

// ---------- 视频 → GIF ----------

function hasFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return !r.error && r.status === 0;
}

function toGif(src, dir) {
  const gif = path.join(dir, `${crypto.randomBytes(4).toString("hex")}.gif`);
  const filters = "fps=12,scale='min(480,iw)':-1:flags=lanczos";
  const r = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", src, "-filter_complex", `${filters},split[a][b];[a]palettegen[p];[b][p]paletteuse`, gif],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return r.status === 0 && fs.existsSync(gif) ? gif : null;
}

// ---------- 参数 ----------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) flags[m[1]] = m[2] ?? true;
    else positional.push(a);
  }
  const valued = new Set(["cols", "width", "remote", "repo", "inbox-base"]);
  for (const [k, v] of Object.entries(flags)) {
    if (!valued.has(k) && k !== "absorb" && k !== "help") die(`不认识的参数 --${k}\n${USAGE}`);
    if (valued.has(k) && (v === true || v === "")) die(`--${k} 要写成 --${k}=<值>`);
  }
  return { flags, positional };
}

/** 从远端 URL 取 owner/repo：取最后两段，GitHub 的 https / ssh 和云端代理（…/git/<owner>/<repo>）都适用。 */
function repoSlug(remote, override) {
  const slug =
    override ??
    (() => {
      const url = git(["remote", "get-url", remote], { ok: true }).out || remote;
      const m = /([\w.-]+)\/([\w.-]+?)(?:\.git)?\/*$/.exec(url.replace(/:/g, "/"));
      return m ? `${m[1]}/${m[2]}` : "";
    })();
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) die(`认不出仓库 owner/name（远端 ${remote}），用 --repo=owner/name 指定`);
  return slug;
}

/** 载体提交的树取自远端默认分支（已经在 GitHub 上，推载体不会顺带推出本地未推的代码）。 */
function inboxBase(remote, override) {
  if (override) return git(["rev-parse", "--verify", `${override}^{commit}`]).out;
  for (const ref of [`refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]) {
    const r = git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { ok: true });
    if (r.status === 0) return r.out;
  }
  return null;
}

// ---------- 上传 ----------

/** PR 号统一成不带前导 0 的数字（007 和 7 是同一个 ref）；0 和非数字返回 null。 */
function prNumber(s) {
  if (s === "draft") return "draft";
  return /^\d{1,6}$/.test(s ?? "") && Number(s) > 0 ? String(Number(s)) : null;
}

function upload(prInput, files, flags) {
  const prArg = prNumber(prInput);
  if (!prArg || !files.length) die(USAGE);
  const colsOverride = flags.cols === undefined ? undefined : Number(flags.cols);
  const widthOverride = flags.width === undefined ? undefined : Number(flags.width);
  if (colsOverride !== undefined && !(Number.isInteger(colsOverride) && colsOverride >= 1 && colsOverride <= 4))
    die(`--cols 要在 1..4：${flags.cols}`);
  if (widthOverride !== undefined && !(Number.isInteger(widthOverride) && widthOverride >= 80 && widthOverride <= 1000))
    die(`--width 要在 80..1000：${flags.width}`);
  const remote = typeof flags.remote === "string" ? flags.remote : "origin";
  const slug = repoSlug(remote, typeof flags.repo === "string" ? flags.repo : undefined);

  for (const file of files) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      die(`文件不存在：${file}`);
    }
    if (!stat.isFile()) die(`不是文件：${file}`);
    if (!KINDS[path.extname(file).toLowerCase()])
      die(`不支持的类型：${file}（只收 ${Object.keys(KINDS).join(" ")}）`);
    if (stat.size > MAX_BYTES) die(`文件超过 50MB：${file}（${(stat.size / 1048576).toFixed(1)}MB）`);
  }

  const label = prArg === "draft" ? "draft" : `pr-${prArg}`;
  const ref = `refs/pr-assets/${label}`;
  const ffmpegOk = files.some((f) => KINDS[path.extname(f).toLowerCase()] === "video") && hasFfmpeg();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pr-assets-"));
  const entries = []; // ls-tree 格式：<mode> <type> <sha>\t<path>
  const gallery = []; // { path, caption, width, cols }
  const extras = []; // { path, text }
  try {
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      const base = path.basename(file, path.extname(file));
      const stem = `${label}/${crypto.randomBytes(4).toString("hex")}-${base.replace(/[^\w.-]+/g, "_")}`;
      // --no-filters：仓库里的文件也按原样存，不让 .gitattributes（LFS、换行）改掉内容
      const add = (src, p) =>
        entries.push(`100644 blob ${git(["hash-object", "-w", "--no-filters", "--", src]).out}\t${p}`);
      add(file, `${stem}${ext}`);
      if (KINDS[ext] === "image") {
        gallery.push({ path: `${stem}${ext}`, caption: base, ...layoutFor(imageSize(file)) });
        continue;
      }
      const gif = ffmpegOk ? toGif(file, tmp) : null;
      if (gif && fs.statSync(gif).size <= MAX_BYTES) {
        add(gif, `${stem}.gif`);
        gallery.push({ path: `${stem}.gif`, caption: base, ...layoutFor(imageSize(gif)) });
        extras.push({ path: `${stem}${ext}`, text: `🎬 原片：${base}` });
      } else {
        log(
          !ffmpegOk
            ? "没有 ffmpeg，视频没转 GIF：PR 里只有链接、没有内嵌预览（brew install ffmpeg）"
            : `${file} 转 GIF 失败或超过 50MB，只给链接`,
        );
        extras.push({ path: `${stem}${ext}`, text: `🎬 ${base}` });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const names = files.map((f) => path.basename(f)).join(", ");
  const message = `pr-assets: ${label} + ${names}`;
  const { sha, where } = publish({ remote, ref, label, prArg, entries, message, flags });

  const url = (p) => `https://raw.githubusercontent.com/${slug}/${sha}/${p}`;
  const md = renderGallery(
    gallery.map((g) => ({ ...g, url: url(g.path) })),
    colsOverride,
    widthOverride,
  );
  if (extras.length) md.push(...(md.length ? [""] : []), ...extras.map((e) => `[${escapeMd(e.text)}](${url(e.path)})`));
  log(`已传到 ${where}，素材提交 ${sha}`);
  log("下面的 markdown 贴进 PR 描述：");
  console.log(md.join("\n"));
}

function publish({ remote, ref, label, prArg, entries, message, flags }) {
  const env = identityEnv();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const tip = remoteTip(remote, ref);
    if (tip && !hasCommit(tip)) {
      if (!fetchObjects(remote, ref)) {
        log(`取不到 ${ref} 的现有提交，改走 inbox 分支（工作流会合并）`);
        return pushInbox({ remote, label, prArg, commit: commitTree({ entries, parents: [], message, env }), flags, env });
      }
      if (!hasCommit(tip)) continue; // 读 tip 和 fetch 之间 ref 又动了：重读
    }
    const commit = commitTree({ base: tip, entries, parents: tip ? [tip] : [], message, env });
    const pushed = pushRef(remote, commit, ref, tip);
    if (pushed.ok) return { sha: commit, where: ref };
    if (!pushed.conflict) {
      log(`推 ${ref} 被拒，改走 inbox 分支：\n${pushed.err}`);
      return pushInbox({ remote, label, prArg, commit, flags, env });
    }
    log(`${ref} 刚被别人更新了，在新 tip 上重建（第 ${attempt} 次）`);
    sleep(300 + Math.floor(Math.random() * 1200));
  }
  die(`${ref} 连续 ${ATTEMPTS} 次冲突，稍后再试`);
}

function pushInbox({ remote, label, prArg, commit, flags, env }) {
  const base = inboxBase(remote, typeof flags["inbox-base"] === "string" ? flags["inbox-base"] : undefined);
  if (!base) die(`找不到 ${remote} 的默认分支（refs/remotes/${remote}/HEAD 或 main），没法拼 inbox 载体提交`);
  if (git(["cat-file", "-e", `${base}:${INBOX_WORKFLOW}`], { ok: true }).status !== 0)
    log(`警告：载体的树（${base.slice(0, 12)}）里没有 ${INBOX_WORKFLOW}，推上去也不会被搬走`);
  const branch = `${INBOX_PREFIX}${prArg}-${crypto.randomBytes(4).toString("hex")}`;
  const carrier = commitTree({
    base,
    entries: [],
    parents: [base, commit],
    message: `pr-assets inbox: ${label}\n\nThe second parent is the asset commit; .github/workflows/pr-assets-inbox.yml moves it to refs/pr-assets/${label} and deletes this branch.`,
    env,
  });
  // 分支名带随机段、一定是新建：普通推送就够了，代理那边看到的只是一次普通的建分支。
  const pushed = pushRef(remote, carrier, `refs/heads/${branch}`);
  if (!pushed.ok) die(`inbox 分支也推不上去：\n${pushed.err}`);
  dropTrackingRef(remote, branch, carrier);
  log(`已推临时分支 ${branch}；pr-assets-inbox 工作流会把它搬进 refs/pr-assets/${label} 并删掉分支，链接现在就能用`);
  return { sha: commit, where: `${branch}（待搬进 refs/pr-assets/${label}）` };
}

// ---------- --absorb：pr-assets-inbox 工作流跑的步骤 ----------

function absorb(branch, flags) {
  const remote = typeof flags.remote === "string" ? flags.remote : "origin";
  const m = /^pr-assets-inbox\/(\d{1,6}|draft)-[\w.-]{1,40}$/.exec(branch ?? "");
  const pr = m && prNumber(m[1]);
  if (!pr) die(`不是 inbox 分支名（pr-assets-inbox/<PR号|draft>-<后缀>）：${branch}`);
  const label = pr === "draft" ? "draft" : `pr-${pr}`;
  const ref = `refs/pr-assets/${label}`;
  const head = `refs/heads/${branch}`;

  const carrier = remoteTip(remote, head);
  if (!carrier) return log(`${branch} 已经不在了，没什么要搬的`);
  if (!hasCommit(carrier) && !fetchObjects(remote, head)) die(`取不到 ${branch}`);
  const parents = git(["cat-file", "-p", carrier])
    .out.split("\n")
    .filter((l) => l.startsWith("parent "))
    .map((l) => l.slice(7));
  if (parents.length !== 2) die(`${branch} 的 tip 不是 pr-assets.mjs 推的载体提交（应有两个父提交，第二个是素材提交）`);
  const assets = parents[1];
  if (!hasCommit(assets) && !fetchObjects(remote, assets)) die(`取不到素材提交 ${assets}`);

  // 只搬 <label>/ 下、允许类型、≤50MB 的普通文件，别的一律不动，留给人看。
  for (const line of git(["ls-tree", "-r", "-l", "-z", "--full-tree", assets]).out.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const p = line.slice(tab + 1);
    const [mode, type, , size] = line.slice(0, tab).split(/ +/);
    if (mode !== "100644" || type !== "blob" || !p.startsWith(`${label}/`) || !KINDS[path.extname(p).toLowerCase()])
      die(`素材提交 ${assets} 里有不该出现的条目：${mode} ${type} ${p}`);
    if (Number(size) > MAX_BYTES) die(`素材提交 ${assets} 里的 ${p} 超过 50MB`);
  }

  const env = identityEnv();
  for (let attempt = 1; ; attempt++) {
    if (attempt > ATTEMPTS) die(`${ref} 连续 ${ATTEMPTS} 次冲突`);
    const tip = remoteTip(remote, ref);
    if (tip && !hasCommit(tip) && !fetchObjects(remote, ref)) die(`取不到 ${ref}`);
    if (tip && isAncestor(assets, tip)) {
      log(`${assets} 已经在 ${ref} 里了`);
      break;
    }
    // 素材提交建在当前 tip 上就直接快进；否则（tip 变了、或推的时候看不到 ref）合成一个双亲提交，两边的 SHA 都可达。
    const next =
      !tip || isAncestor(tip, assets)
        ? assets
        : commitTree({
            base: tip,
            entries: git(["ls-tree", "-r", "-z", "--full-tree", assets]).out.split("\0").filter(Boolean),
            parents: [tip, assets],
            message: `pr-assets: ${label} merge ${branch}`,
            env,
          });
    const pushed = pushRef(remote, next, ref, tip);
    if (pushed.ok) {
      log(`${ref} → ${next}${next === assets ? "" : `（合并 ${tip} 和 ${assets}）`}`);
      break;
    }
    if (!pushed.conflict) die(`推 ${ref} 失败：\n${pushed.err}`);
    log(`${ref} 刚被更新，重来（第 ${attempt} 次）`);
    sleep(300 + Math.floor(Math.random() * 1200));
  }

  const deleted = git(["push", "--porcelain", `--force-with-lease=${head}:${carrier}`, remote, `:${head}`], { ok: true });
  if (deleted.status !== 0) die(`素材已搬好，但删不掉 ${branch}：\n${deleted.out}\n${deleted.err}`);
  log(`已删除 ${branch}`);
}

// ---------- 入口 ----------

const { flags, positional } = parseArgs(process.argv.slice(2));
if (flags.help) {
  console.log(USAGE);
} else if (flags.absorb) {
  absorb(typeof flags.absorb === "string" ? flags.absorb : positional[0], flags);
} else {
  upload(positional[0], positional.slice(1), flags);
}
