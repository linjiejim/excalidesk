// 更新直接来自 GitHub Releases：读最新一个已发布 release（草稿不算）里的 latest.json，下载对应的
// .app.tar.gz，用 tauri.conf.json 里的公钥验签，原地换掉 App，再提示重启。
// 重启走 closeApp(true)：和关窗一样先把文档存完。
import { closeApp } from "./actions";
import { t } from "./i18n";
import { inTauri } from "./ipc";
import { getState, hidePrompt, showPrompt, toast } from "./store";

/** 第一次自动检查等 App 稳定下来，之后每隔几小时一次 */
const FIRST_CHECK = 10_000;
const EVERY = 6 * 60 * 60 * 1000;
const PROMPT = "update";

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 已经装到磁盘上、等重启的版本 */
let installed: string | null = null;
let running: Promise<void> | null = null;
/** 用户主动点的（菜单、设置）：每种结果都要告诉他，不只是装好了 */
let asked = false;
/** 正在下载的版本；用户点过才显示进度 */
let downloading: string | null = null;

function showProgress() {
  if (downloading) showPrompt({ id: PROMPT, msg: t("update.downloading", { version: downloading }) });
}

function offerRestart(version: string) {
  showPrompt({ id: PROMPT, msg: t("update.ready", { version }), action: { label: t("update.restart"), run: () => void closeApp(true) } });
}

async function update() {
  const [{ check }, { getVersion }] = await Promise.all([import("@tauri-apps/plugin-updater"), import("@tauri-apps/api/app")]);
  const found = await check({ timeout: 30_000 });
  if (!found) {
    if (asked) toast(t("update.latest", { version: await getVersion() }));
    return;
  }
  downloading = found.version;
  if (asked) showProgress();
  try {
    await found.downloadAndInstall();
  } finally {
    downloading = null;
    hidePrompt(PROMPT);
  }
  installed = found.version;
  offerRestart(found.version);
}

/** manual：用户主动点的，「已是最新」和出错也要显示；自动检查不打扰 */
export function checkForUpdates(manual: boolean): Promise<void> {
  // tauri dev 跑的是裸二进制，不是能替换的 .app
  if (!inTauri || import.meta.env.DEV) {
    if (manual) toast(t("update.installedOnly"));
    return Promise.resolve();
  }
  if (installed) {
    if (manual) offerRestart(installed);
    return Promise.resolve();
  }
  if (manual) {
    asked = true;
    // 自动检查已经在下载了，接上它的进度
    showProgress();
  }
  running ??= update()
    .catch((e) => {
      if (asked) toast(t("update.failed", { reason: reason(e) }));
      else console.warn("update", e);
    })
    .finally(() => {
      running = null;
      asked = false;
    });
  return running;
}

/** 启动时和之后每隔几小时，设置打开时才查。返回停止函数 */
export function scheduleUpdateChecks(): () => void {
  if (!inTauri || import.meta.env.DEV) return () => {};
  const tick = () => {
    if (getState().settings.autoUpdate) void checkForUpdates(false);
  };
  const first = setTimeout(tick, FIRST_CHECK);
  const every = setInterval(tick, EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
