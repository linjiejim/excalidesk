// Excalidesk site: language, theme-aware screenshots, latest release, a few small animations.
(() => {
  const REPO = "linjiejim/excalidesk";

  // ── Copy. English lives in the HTML; this table has both so switching back and forth is exact. ──
  const zh = {
    "meta.title": "Excalidesk — Mac 上的 Excalidraw",
    "meta.desc": "快、离线优先的 Excalidraw macOS 桌面版：图就是你选的文件夹里的 .excalidraw 文件，iCloud Drive 同步，120Hz 跟手，Claude Code、Codex 通过 MCP 和你一起画，frame 还能当幻灯片放映。免费开源。",
    "nav.speed": "性能",
    "nav.agents": "Agent 协作",
    "nav.present": "演示",
    "nav.files": "文件",
    "nav.download": "下载",
    "hero.eyebrow": "Mac 上的 Excalidraw · 免费开源",
    "hero.title": "Excalidraw，<em>住进</em>你的 Mac。",
    "hero.lede": "快、离线优先的 Excalidraw 桌面版。每张图都是你选的文件夹里一个普通的 <code>.excalidraw</code> 文件，iCloud Drive 同步，120Hz 跟手；Claude Code、Codex 也能在上面和你一起画。",
    "hero.download": "下载 Mac 版",
    "hero.github": "GitHub 源码",
    "hero.meta": "macOS 13+ · Apple 芯片（Intel 版在下方）· MIT 许可",
    "pin.1": "<strong>是文件夹，不是图库。</strong>工作区就是普通文件夹，在不在 iCloud Drive 里都行。每张图都是 <code>.excalidraw</code> 文件，哪里都能打开。",
    "pin.2": "<strong>Agent 直接画在你的图上。</strong>Claude Code 画的东西和你自己的改动一样保存、留档，一键撤销。",
    "pin.3": "<strong>按 C 批注。</strong>给任意元素钉一张便签。Agent 收到时连同它指着的元素一起，改完标成已处理。",
    "pin.4": "<strong>什么时候发回，你说了算。</strong>Agent 在那边等着，你点「发回」之前什么都不会发过去。",
    "pin.5": "<strong>存好了，同步了，留档了。</strong>增量保存、实时 iCloud 状态，还有能一键恢复的本地历史版本。",
    "num.fps": "fps：ProMotion 屏上平移、手绘",
    "num.mb": "MB 安装包，不是一整个浏览器",
    "num.accounts": "个账号、服务器、数据库",
    "num.format": "种格式：标准 .excalidraw",
    "speed.title": "像 Chrome 一样跟手，<span>像原生 App 一样轻。</span>",
    "speed.lede": "嵌在 Mac App 里的网页默认被压在 60fps，ProMotion 屏也一样。Excalidesk 解除了这个限制：平移和手绘都是 120fps，和 Chrome 里一样跟手。",
    "speed.t1": "<strong>保存不卡。</strong>只有改过的元素交给 Rust 那一侧，再大的图保存时画布也不卡。",
    "speed.t2": "<strong>图片只传一次。</strong>每张图片只在第一次出现时传过去，不会每次保存都重新编码。",
    "speed.t3": "<strong>滚动不算修改。</strong>视口不写进文件，在画布上随便拖动不会触发 iCloud 上传。",
    "speed.chart": "100% 缩放下平移的帧率，M1 Pro + ProMotion 屏",
    "speed.default": "网页视图默认",
    "speed.yours": "你这块屏幕现在：",
    "agents.title": "和你的 Agent <span>一起画。</span>",
    "agents.lede": "Claude Code、Codex 等 MCP 客户端可以在 Excalidesk 里开图，画原型、流程和架构，一个方案一个 frame。你直接在图上改，或者钉上批注，再点「发回」；它们接着改，并逐条回复。",
    "loop.1t": "Agent 画方案",
    "loop.1d": "线框图、流程图、Mermaid，全是可编辑的元素。画完自己渲染一张 PNG 检查。",
    "loop.2t": "你改图、批注",
    "loop.2d": "直接挪、删、改字；或者选中元素按 C，钉一张便签。",
    "loop.3t": "你点「发回」",
    "loop.3d": "Agent 收到未处理的批注和它们指着的元素、你做的每处改动，外加一张带批注的 PNG。",
    "loop.4t": "它改，并回复",
    "loop.4d": "每条批注标成已处理，附一句回复。不满意就再来一轮。",
    "agents.term": "接入 Agent",
    "agents.t1": "<strong>不用先开 App。</strong>Agent 第一次调用时会在后台把 Excalidesk 拉起来。命令在 设置（⌘,）→ Agent 里也能复制。",
    "agents.t2": "<strong>可以同时开好几个。</strong>每个 Agent 在自己的后台标签里画，不抢你手上那张。",
    "agents.t3": "<strong>有边界。</strong>Agent 只能碰工作区里的图；设置里一个开关就能全部关掉。",
    copy: "复制",
    copied: "已复制",
    "present.title": "画布，<span>就是幻灯片。</span>",
    "present.lede": "每个 frame 就是一页。自己画，或者让 Agent 排好一整套，再按 ⌥⌘P 全屏放映，从左到右一页一页翻。",
    "present.t1": "<strong>直接在画布上放映。</strong>当前页铺满屏幕，相邻的页都被遮住。方向键翻页，按 K 是激光笔。",
    "present.t2": "<strong>每页下面放演讲者备注。</strong>备注写在页下方的备注 frame 里，观众看不到；排练时按 N 叠在画面上。",
    "present.t3": "<strong>导出 PDF，一页一张。</strong>按放映顺序导出，方便发给别人。批注和备注都不会带进去。",
    "present.t4": "<strong>Agent 也能做整套幻灯片。</strong>让 Claude Code 准备一场分享，它会建好 1920×1080 的页、写好备注；有东西超出页面，它会收到提示。",
    "deck.s1": "开场",
    "deck.s2": "计划",
    "deck.s3": "发布",
    "deck.notes": "先打招呼，再讲计划。",
    "deck.k1": "放映",
    "deck.k2": "翻页",
    "deck.k3": "激光笔",
    "deck.k4": "备注",
    "files.title": "图，<span>就是文件。</span>",
    "files.lede": "没有图库，不用导入，也不会被锁住。工作区就是文件夹，每张图都是标准的 .excalidraw 文件，excalidraw.com、Obsidian 插件、git 都能直接用。",
    "files.t1": "<strong>iCloud 同步，状态看得见。</strong>每个文件的上传、下载一目了然；还在云端的文件，打开时自动下载。",
    "files.t2": "<strong>外部修改按元素合并。</strong>在另一台 Mac 上、git 里或者用脚本改了？按元素合并，不整份覆盖，iCloud 冲突版本也一样。",
    "files.t3": "<strong>本地历史版本。</strong>边画边自动留档，合并前先备份。可以一键恢复，也可以另存为副本。",
    "files.t4": "<strong>写得小心。</strong>经系统文件协调原子写入。文件在外部被删除或移走时暂停保存，不会把它写回来。",
    "files.opens": "直接就能打开：",
    "tree.arch": "架构",
    "tree.product": "产品",
    "tree.f1": "系统架构",
    "tree.f2": "数据流",
    "tree.f3": "App 首页改版",
    "tree.f4": "用户旅程",
    "tree.synced": "已同步",
    "tree.cloud": "在云端",
    "tree.up": "上传中",
    "more.title": "还有<span>这些细节。</span>",
    "m1.t": "标签页和原生菜单",
    "m1.d": "原生菜单栏和快捷键、多标签；Finder 里双击 .excalidraw 直接打开。",
    "m2.t": "顺手的侧边栏",
    "m2.d": "右键菜单、双击改名、拖动调整工作区顺序，按修改时间、创建时间或名称排序。",
    "m3.t": "浅色、深色、跟随系统",
    "m3.d": "画布和窗口用同一套主题，中文、English 随时切换。",
    "m4.t": "PNG、SVG、PDF 导出",
    "m4.d": "PDF 一页一张幻灯片。导出时自动去掉批注；用 excalidraw.com 打开，批注就是普通便签。",
    "m5.t": "自动更新",
    "m5.d": "从 GitHub Releases 检查更新，用 App 内置的公钥验签，重启后装好。",
    "m6.t": "里面是官方 Excalidraw",
    "m6.d": "用官方 npm 包，不是 fork；字体都打包在内，完全离线。同一个编辑器，同一种文件。",
    "dl.title": "下载 Excalidesk",
    "dl.lede": "免费开源，MIT 许可。需要 macOS 13 Ventura 或更高版本。",
    "dl.arm": "Apple 芯片",
    "dl.intel": "Intel",
    "dl.all": "所有版本和更新说明",
    "dl.gatekeeper": "<strong>第一次打开：</strong>Excalidesk 暂时还没经过 Apple 公证，第一次打开时 macOS 会拦一下。到 <b>系统设置 → 隐私与安全性</b>，点 <b>仍要打开</b> 即可。之后它会自己更新。",
    "foot.text": "Excalidesk 是基于开源 <a href=\"https://github.com/excalidraw/excalidraw\">Excalidraw</a> 的独立项目，与 Excalidraw 官方无关。手写字体为 Excalifont（SIL OFL 1.1）。",
    alt: "Excalidesk：侧边栏是 iCloud Drive 里的工作区，画布上 Claude Code 画了两版登录页和一张流程图，按钮上钉着一条批注",
  };

  // English: read once from the page so the HTML stays the single English source.
  const en = {
    "meta.title": document.title,
    "meta.desc": document.querySelector('meta[name="description"]').content,
    copy: "Copy",
    copied: "Copied",
    alt: document.getElementById("shot").alt,
  };
  document.querySelectorAll("[data-i18n]").forEach((el) => (en[el.dataset.i18n] ??= el.textContent));
  document.querySelectorAll("[data-i18n-html]").forEach((el) => (en[el.dataset.i18nHtml] ??= el.innerHTML));

  const dark = matchMedia("(prefers-color-scheme: dark)");
  const shot = document.getElementById("shot");
  const langBtn = document.getElementById("lang");
  let lang = localStorage.getItem("lang") || (navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");

  function setShot() {
    shot.src = `screens/${lang}/main-${dark.matches ? "dark" : "light"}.webp`;
  }

  function apply() {
    const t = lang === "zh" ? zh : en;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = t["meta.title"];
    document.querySelector('meta[name="description"]').content = t["meta.desc"];
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const v = t[el.dataset.i18n];
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const v = t[el.dataset.i18nHtml];
      if (v != null) el.innerHTML = v;
    });
    shot.alt = t.alt;
    langBtn.textContent = lang === "zh" ? "EN" : "中文";
    langBtn.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
    setShot();
  }

  langBtn.addEventListener("click", () => {
    lang = lang === "zh" ? "en" : "zh";
    localStorage.setItem("lang", lang);
    apply();
  });
  dark.addEventListener("change", setShot);
  apply();

  // ── Latest release: version and the two DMGs (falls back to the releases page) ──
  const mb = (n) => `${Math.round(n / 1e6)} MB`;
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const find = (re) => rel.assets.find((a) => re.test(a.name));
      const arm = find(/_aarch64\.dmg$/);
      const intel = find(/_x64\.dmg$/);
      document.querySelectorAll(".version, .version-text").forEach((el) => (el.textContent = rel.tag_name));
      if (arm) {
        document.querySelectorAll(".dl-arm").forEach((a) => (a.href = arm.browser_download_url));
        document.querySelector(".download .dl-arm .dl-size").textContent = mb(arm.size);
      }
      if (intel) {
        document.querySelector(".dl-intel").href = intel.browser_download_url;
        document.querySelector(".dl-intel .dl-size").textContent = mb(intel.size);
      }
    })
    .catch(() => {});

  // ── Copy buttons ──
  document.querySelectorAll(".copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = btn.parentElement.querySelector("code").textContent;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const r = document.createRange();
        r.selectNodeContents(btn.parentElement.querySelector("code"));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        return;
      }
      const t = lang === "zh" ? zh : en;
      btn.textContent = t.copied;
      btn.classList.add("done");
      setTimeout(() => {
        btn.textContent = t.copy;
        btn.classList.remove("done");
      }, 1600);
    });
  });

  // ── Pins ↔ legend ──
  const mark = (n, on) => document.querySelectorAll(`[data-pin="${n}"]`).forEach((el) => el.classList.toggle("on", on));
  document.querySelectorAll("[data-pin]").forEach((el) => {
    el.addEventListener("mouseenter", () => mark(el.dataset.pin, true));
    el.addEventListener("mouseleave", () => mark(el.dataset.pin, false));
    el.addEventListener("focus", () => mark(el.dataset.pin, true));
    el.addEventListener("blur", () => mark(el.dataset.pin, false));
  });

  // ── Nav border once scrolled; the window tilts upright as it comes into view ──
  const nav = document.querySelector(".nav");
  const mac = document.querySelector(".mac");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const onScroll = () => {
    nav.classList.toggle("scrolled", scrollY > 8);
    if (still) return;
    const r = mac.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (innerHeight - r.top) / (innerHeight * 0.75)));
    mac.style.setProperty("--tilt", `${(1 - p) * 14}deg`);
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ── Reveal, count-up, bars, refresh-rate meter ──
  const reveal = document.querySelectorAll(".numbers > div, .split-copy, .fps, .finder, .loop li, .setup, .grid .card, .download > *");
  if (!still) reveal.forEach((el) => el.classList.add("reveal"));

  function countUp(el) {
    const to = Number(el.dataset.count);
    if (still || to === 0) return;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1100);
      el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Median rAF interval over ~60 frames, snapped to common refresh rates
  function measureHz(out) {
    const ts = [];
    const tick = (t) => {
      ts.push(t);
      if (ts.length < 62) return requestAnimationFrame(tick);
      const d = ts.slice(2).map((t, i) => t - ts[i + 1]).sort((a, b) => a - b);
      const hz = 1000 / d[d.length >> 1];
      const snap = [30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 240].reduce((a, b) => (Math.abs(b - hz) < Math.abs(a - hz) ? b : a));
      out.textContent = `${Math.abs(snap - hz) < 4 ? snap : Math.round(hz)} Hz`;
    };
    requestAnimationFrame(tick);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        el.classList.add("in");
        const n = el.querySelector?.("[data-count]");
        if (n) countUp(n);
        if (el.classList.contains("fps")) {
          el.classList.add("seen");
          measureHz(document.getElementById("hz"));
        }
        io.unobserve(el);
      }
    },
    { threshold: 0.2 },
  );
  reveal.forEach((el) => io.observe(el));
  if (still) document.querySelector(".fps").classList.add("seen");
})();
