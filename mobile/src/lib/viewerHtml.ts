// Self-contained offline HTML5 Canvas renderer & E2EE live collab/share viewer for iOS WebView.
// Zero external CDN dependencies: works 100% offline for iCloud .excalidraw files,
// and uses native WebKit crypto.subtle + WebSocket when previewing #share= or #room= links.

export function buildViewerHtml(opts: { dark: boolean }): string {
  const initialDark = opts.dark ? "true" : "false";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
    background: ${opts.dark ? "#121212" : "#ffffff"};
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  body.dark canvas {
    filter: invert(93%) hue-rotate(180deg);
  }
</style>
</head>
<body class="${opts.dark ? "dark" : ""}">
<canvas id="c"></canvas>
<script>
(function() {
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const post = (msg) => {
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (_) {}
  };

  let scene = { elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
  let imageCache = new Map();
  let collaborators = new Map();
  let isDark = ${initialDark};
  let cam = { x: 0, y: 0, zoom: 1 };
  let anim = null;
  let needsDraw = true;
  let activeWs = null;
  let pingTimer = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }
  window.addEventListener("resize", resize);
  resize();

  function seededRand(seed) {
    let s = (seed || 1) % 2147483647;
    if (s <= 0) s += 2147483646;
    return function() {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  function elemBounds(e) {
    if ((e.type === "line" || e.type === "arrow" || e.type === "freedraw") && Array.isArray(e.points) && e.points.length) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of e.points) {
        const gx = e.x + p[0], gy = e.y + p[1];
        if (gx < minX) minX = gx;
        if (gy < minY) minY = gy;
        if (gx > maxX) maxX = gx;
        if (gy > maxY) maxY = gy;
      }
      return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
    }
    return { x: e.x || 0, y: e.y || 0, w: Math.max(1, Math.abs(e.width || 0)), h: Math.max(1, Math.abs(e.height || 0)) };
  }

  function sceneBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = false;
    for (const e of scene.elements) {
      if (e.isDeleted) continue;
      const b = elemBounds(e);
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      found = true;
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    return found ? { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } : null;
  }

  function fitToBounds(bounds, animate) {
    if (!bounds) {
      cam = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
      needsDraw = true;
      post({ type: "zoom", zoom: 1 });
      return;
    }
    const pad = 32;
    const vw = Math.max(100, window.innerWidth - pad * 2);
    const vh = Math.max(100, window.innerHeight - pad * 2);
    const z = Math.max(0.05, Math.min(4, Math.min(vw / bounds.w, vh / bounds.h)));
    const tx = window.innerWidth / 2 - (bounds.x + bounds.w / 2) * z;
    const ty = window.innerHeight / 2 - (bounds.y + bounds.h / 2) * z;
    if (!animate) {
      cam = { x: tx, y: ty, zoom: z };
      needsDraw = true;
      post({ type: "zoom", zoom: z });
      return;
    }
    anim = {
      start: performance.now(),
      dur: 260,
      from: { ...cam },
      to: { x: tx, y: ty, zoom: z },
    };
    needsDraw = true;
  }

  function fontFor(e) {
    const size = e.fontSize || 20;
    const fam = e.fontFamily || 1;
    const face = fam === 3
      ? "ui-monospace, SFMono-Regular, Menlo, monospace"
      : fam === 2
        ? "-apple-system, BlinkMacSystemFont, Helvetica Neue, PingFang SC, sans-serif"
        : "Noteworthy, Chalkboard SE, Bradley Hand, PingFang SC, -apple-system, cursive";
    return size + "px " + face;
  }

  function drawRoundedRect(x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function fillShape(e) {
    if (!e.backgroundColor || e.backgroundColor === "transparent") return;
    if (e.fillStyle === "hachure" || e.fillStyle === "cross-hatch") {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = e.backgroundColor;
      ctx.lineWidth = Math.max(1.2, (e.strokeWidth || 2) * 0.85);
      const step = Math.max(7, (e.strokeWidth || 2) * 4);
      const diag = Math.hypot(e.width || 1, e.height || 1);
      ctx.beginPath();
      for (let d = -diag; d <= diag * 2; d += step) {
        ctx.moveTo(d, -10);
        ctx.lineTo(d - diag, diag + 10);
      }
      if (e.fillStyle === "cross-hatch") {
        for (let d = -diag; d <= diag * 2; d += step) {
          ctx.moveTo(d - diag, -10);
          ctx.lineTo(d, diag + 10);
        }
      }
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillStyle = e.backgroundColor;
      ctx.fill();
    }
  }

  function drawArrowhead(tipX, tipY, fromX, fromY, type, size) {
    if (!type) return;
    const angle = Math.atan2(tipY - fromY, tipX - fromX);
    const len = size || 14;
    if (type === "dot") {
      ctx.beginPath();
      ctx.arc(tipX, tipY, len * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }
    if (type === "bar") {
      ctx.beginPath();
      ctx.moveTo(tipX + Math.cos(angle + Math.PI / 2) * len * 0.6, tipY + Math.sin(angle + Math.PI / 2) * len * 0.6);
      ctx.lineTo(tipX - Math.cos(angle + Math.PI / 2) * len * 0.6, tipY - Math.sin(angle + Math.PI / 2) * len * 0.6);
      ctx.stroke();
      return;
    }
    const spread = 0.45;
    const x1 = tipX - len * Math.cos(angle - spread);
    const y1 = tipY - len * Math.sin(angle - spread);
    const x2 = tipX - len * Math.cos(angle + spread);
    const y2 = tipY - len * Math.sin(angle + spread);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(x2, y2);
    if (type === "triangle") {
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    ctx.stroke();
  }

  function loadImage(fileId) {
    if (imageCache.has(fileId)) return imageCache.get(fileId);
    const f = scene.files && scene.files[fileId];
    if (!f || !f.dataURL) return null;
    const img = new Image();
    img.onload = () => { needsDraw = true; };
    img.src = f.dataURL;
    imageCache.set(fileId, img);
    return img;
  }

  function drawElement(e) {
    if (e.isDeleted) return;
    ctx.save();
    ctx.globalAlpha = typeof e.opacity === "number" ? e.opacity / 100 : 1;

    const w = e.width || 0;
    const h = e.height || 0;
    const cx = e.x + w / 2;
    const cy = e.y + h / 2;
    if (e.angle) {
      ctx.translate(cx, cy);
      ctx.rotate(e.angle);
      ctx.translate(-cx, -cy);
    }

    ctx.strokeStyle = e.strokeColor || "#1e1e1e";
    ctx.lineWidth = e.strokeWidth || 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (e.strokeStyle === "dashed") ctx.setLineDash([8, 6]);
    else if (e.strokeStyle === "dotted") ctx.setLineDash([2, 5]);
    else ctx.setLineDash([]);

    if (e.type === "frame" || e.type === "magicframe") {
      ctx.strokeStyle = e.strokeColor || "#bbbbbb";
      ctx.lineWidth = 1.5;
      drawRoundedRect(e.x, e.y, w, h, 8);
      ctx.stroke();
      if (e.name) {
        ctx.fillStyle = "#868e96";
        ctx.font = "600 14px -apple-system, BlinkMacSystemFont, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(e.name, e.x + 2, e.y - 6);
      }
    } else if (e.type === "rectangle") {
      ctx.translate(e.x, e.y);
      const r = e.roundness ? Math.min(20, Math.min(Math.abs(w), Math.abs(h)) * 0.18) : 0;
      drawRoundedRect(0, 0, w, h, r);
      fillShape(e);
      if (e.strokeColor !== "transparent") ctx.stroke();
    } else if (e.type === "ellipse") {
      ctx.translate(e.x, e.y);
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
      fillShape(e);
      if (e.strokeColor !== "transparent") ctx.stroke();
    } else if (e.type === "diamond") {
      ctx.translate(e.x, e.y);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(w / 2, h);
      ctx.lineTo(0, h / 2);
      ctx.closePath();
      fillShape(e);
      if (e.strokeColor !== "transparent") ctx.stroke();
    } else if ((e.type === "line" || e.type === "arrow") && Array.isArray(e.points) && e.points.length >= 2) {
      ctx.translate(e.x, e.y);
      const pts = e.points;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0], pts[i][1]);
      }
      if (e.type === "line" && pts.length > 2) {
        const first = pts[0], last = pts[pts.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 4) fillShape(e);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (e.type === "arrow") {
        const last = pts[pts.length - 1], prev = pts[pts.length - 2];
        drawArrowhead(last[0], last[1], prev[0], prev[1], e.endArrowhead ?? "arrow", Math.max(12, (e.strokeWidth || 2) * 5));
        if (e.startArrowhead) {
          drawArrowhead(pts[0][0], pts[0][1], pts[1][0], pts[1][1], e.startArrowhead, Math.max(12, (e.strokeWidth || 2) * 5));
        }
      }
    } else if (e.type === "freedraw" && Array.isArray(e.points) && e.points.length >= 2) {
      ctx.translate(e.x, e.y);
      const pts = e.points;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    } else if (e.type === "text") {
      const text = String(e.text ?? e.originalText ?? "");
      const lines = text.split("\\n");
      const fontSize = e.fontSize || 20;
      const lineHeight = fontSize * (e.lineHeight || 1.25);
      ctx.fillStyle = e.strokeColor || "#1e1e1e";
      ctx.font = fontFor(e);
      ctx.textBaseline = "top";
      const align = e.textAlign || "left";
      ctx.textAlign = align;
      const tx = align === "center" ? e.x + w / 2 : align === "right" ? e.x + w : e.x;
      const totalH = lines.length * lineHeight;
      let startY = e.y;
      if (e.verticalAlign === "middle") startY = e.y + Math.max(0, (h - totalH) / 2);
      else if (e.verticalAlign === "bottom") startY = e.y + Math.max(0, h - totalH);
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], tx, startY + i * lineHeight);
      }
    } else if (e.type === "image" && e.fileId) {
      const img = loadImage(e.fileId);
      if (img && img.complete && img.naturalWidth > 0) {
        if (isDark) {
          ctx.save();
          ctx.filter = "invert(93%) hue-rotate(180deg)";
          ctx.drawImage(img, e.x, e.y, w, h);
          ctx.restore();
        } else {
          ctx.drawImage(img, e.x, e.y, w, h);
        }
      } else {
        ctx.fillStyle = "#f1f3f5";
        ctx.fillRect(e.x, e.y, w, h);
      }
    }
    ctx.restore();
  }

  function drawCollaborators() {
    for (const c of collaborators.values()) {
      if (!c.pointer) continue;
      const sx = c.pointer.x * cam.zoom + cam.x;
      const sy = c.pointer.y * cam.zoom + cam.y;
      const color = (c.color && c.color.stroke) || "#6965db";
      ctx.save();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 4, sy + 15);
      ctx.lineTo(sx + 8, sy + 10);
      ctx.lineTo(sx + 14, sy + 10);
      ctx.closePath();
      ctx.fill();
      if (c.username) {
        ctx.font = "600 11px -apple-system, BlinkMacSystemFont, sans-serif";
        const tw = ctx.measureText(c.username).width;
        ctx.fillStyle = color;
        drawRoundedRect(sx + 10, sy + 12, tw + 12, 20, 6);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(c.username, sx + 16, sy + 22);
      }
      ctx.restore();
    }
  }

  function render() {
    if (anim) {
      const t = Math.min(1, (performance.now() - anim.start) / anim.dur);
      const ease = 1 - Math.pow(1 - t, 3);
      cam.x = anim.from.x + (anim.to.x - anim.from.x) * ease;
      cam.y = anim.from.y + (anim.to.y - anim.from.y) * ease;
      cam.zoom = anim.from.zoom + (anim.to.zoom - anim.from.zoom) * ease;
      if (t >= 1) {
        anim = null;
        post({ type: "zoom", zoom: cam.zoom });
      }
      needsDraw = true;
    }

    if (needsDraw) {
      needsDraw = false;
      const bg = (scene.appState && scene.appState.viewBackgroundColor) || "#ffffff";
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      ctx.save();
      ctx.translate(cam.x, cam.y);
      ctx.scale(cam.zoom, cam.zoom);
      for (const e of scene.elements) drawElement(e);
      ctx.restore();

      drawCollaborators();
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // Touch & mouse gestures (1-finger pan, 2-finger pinch zoom, double-tap fit, single-tap HUD toggle)
  let pointers = new Map();
  let lastDist = 0;
  let lastCenter = null;
  let tapStart = null;
  let moved = false;
  let lastTapTime = 0;

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  canvas.addEventListener("pointerdown", (ev) => {
    anim = null;
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 1) {
      tapStart = { x: ev.clientX, y: ev.clientY, time: Date.now() };
      moved = false;
    } else if (pointers.size === 2) {
      moved = true;
      const arr = [...pointers.values()];
      lastDist = dist(arr[0], arr[1]);
      lastCenter = mid(arr[0], arr[1]);
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    const prev = pointers.get(ev.pointerId);
    const cur = { x: ev.clientX, y: ev.clientY };
    pointers.set(ev.pointerId, cur);

    if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (tapStart && Math.hypot(cur.x - tapStart.x, cur.y - tapStart.y) > 6) moved = true;
      cam.x += dx;
      cam.y += dy;
      needsDraw = true;
    } else if (pointers.size === 2) {
      const arr = [...pointers.values()];
      const d = dist(arr[0], arr[1]);
      const c = mid(arr[0], arr[1]);
      if (lastDist > 0 && lastCenter) {
        const factor = d / lastDist;
        const nextZoom = Math.max(0.05, Math.min(8, cam.zoom * factor));
        const ratio = nextZoom / cam.zoom;
        cam.x = c.x - (c.x - cam.x) * ratio + (c.x - lastCenter.x);
        cam.y = c.y - (c.y - cam.y) * ratio + (c.y - lastCenter.y);
        cam.zoom = nextZoom;
        needsDraw = true;
        post({ type: "zoom", zoom: cam.zoom });
      }
      lastDist = d;
      lastCenter = c;
    }
  });

  function endPointer(ev) {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) {
      lastDist = 0;
      lastCenter = null;
    }
    if (pointers.size === 0 && tapStart && !moved && Date.now() - tapStart.time < 280) {
      const now = Date.now();
      if (now - lastTapTime < 280) {
        lastTapTime = 0;
        fitToBounds(sceneBounds(), true);
      } else {
        lastTapTime = now;
        post({ type: "tap" });
      }
    }
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 0.89;
    const nextZoom = Math.max(0.05, Math.min(8, cam.zoom * factor));
    const ratio = nextZoom / cam.zoom;
    cam.x = ev.clientX - (ev.clientX - cam.x) * ratio;
    cam.y = ev.clientY - (ev.clientY - cam.y) * ratio;
    cam.zoom = nextZoom;
    needsDraw = true;
    post({ type: "zoom", zoom: cam.zoom });
  }, { passive: false });

  // E2EE WebCrypto helpers for previewing #share= and #room= links inside WebView
  function fromB64Url(str) {
    const norm = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = norm.length % 4 === 0 ? "" : "=".repeat(4 - (norm.length % 4));
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function importKey(keyStr) {
    const raw = fromB64Url(keyStr);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: raw.byteLength * 8 }, false, ["decrypt"]);
  }

  async function decryptBytes(blob, key) {
    const iv = blob.subarray(0, 12);
    const cipher = blob.subarray(12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
    return new Uint8Array(plain);
  }

  function mergeElements(local, incoming) {
    const map = new Map(local.map((e) => [e.id, e]));
    for (const el of incoming) {
      const prev = map.get(el.id);
      if (!prev || (el.version || 0) > (prev.version || 0) || ((el.version || 0) === (prev.version || 0) && (el.versionNonce || 0) < (prev.versionNonce || 0))) {
        map.set(el.id, el);
      }
    }
    return [...map.values()];
  }

  async function openCollab(cfg) {
    if (activeWs) { try { activeWs.close(); } catch (_) {} activeWs = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    const base = cfg.serverUrl.replace(/\\/+$/, "");
    let key;
    try {
      key = await importKey(cfg.key);
    } catch (e) {
      post({ type: "collab-error", error: "Invalid encryption key" });
      return;
    }

    if (cfg.kind === "share") {
      try {
        const res = await fetch(base + "/api/shares/" + encodeURIComponent(cfg.id));
        if (!res.ok) throw new Error("HTTP " + res.status);
        const plain = await decryptBytes(new Uint8Array(await res.arrayBuffer()), key);
        const data = JSON.parse(new TextDecoder().decode(plain));
        scene = { elements: data.elements || [], appState: data.appState || {}, files: data.files || {} };
        imageCache.clear();
        fitToBounds(sceneBounds(), false);
        post({ type: "collab-loaded", title: data.title || "", rawJson: JSON.stringify(scene) });
      } catch (e) {
        post({ type: "collab-error", error: String(e) });
      }
      return;
    }

    // Live room read-only viewer
    const wsUrl = (base.startsWith("https://") ? "wss://" + base.slice(8) : "ws://" + base.slice(7)) + "/ws";
    const clientId = "ios_" + Math.random().toString(36).slice(2, 12);
    const ws = new WebSocket(wsUrl);
    activeWs = ws;
    let firstFit = false;

    const downloadFiles = async (ids) => {
      for (const fid of ids) {
        if (scene.files[fid]) continue;
        try {
          const r = await fetch(base + "/api/rooms/" + encodeURIComponent(cfg.id) + "/files/" + encodeURIComponent(fid));
          if (!r.ok) continue;
          const plain = await decryptBytes(new Uint8Array(await r.arrayBuffer()), key);
          const fileObj = JSON.parse(new TextDecoder().decode(plain));
          scene.files[fileObj.id] = fileObj;
          needsDraw = true;
        } catch (_) {}
      }
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", roomId: cfg.id, clientId, readOnly: true }));
      pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 20000);
    };

    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.type === "joined") {
        post({ type: "collab-status", status: "connected", peers: msg.peers.length });
        if (msg.hasSnapshot) {
          try {
            const r = await fetch(base + "/api/rooms/" + encodeURIComponent(cfg.id) + "/snapshot");
            if (r.ok) {
              const plain = await decryptBytes(new Uint8Array(await r.arrayBuffer()), key);
              const snap = JSON.parse(new TextDecoder().decode(plain));
              scene.elements = mergeElements(scene.elements, snap.elements || []);
              if (snap.appState) scene.appState = { ...scene.appState, ...snap.appState };
              if (!firstFit) { firstFit = true; fitToBounds(sceneBounds(), false); }
              needsDraw = true;
              post({ type: "collab-loaded", title: snap.title || "", rawJson: JSON.stringify(scene) });
              if (snap.fileIds && snap.fileIds.length) void downloadFiles(snap.fileIds);
            }
          } catch (_) {}
        }
      } else if (msg.type === "peer-joined" || msg.type === "peer-left") {
        if (msg.type === "peer-left") collaborators.delete(msg.clientId);
        needsDraw = true;
        post({ type: "collab-peers-delta", delta: msg.type === "peer-joined" ? 1 : -1 });
      } else if (msg.type === "sync-scene") {
        try {
          const plain = await decryptBytes(fromB64Url(msg.payload), key);
          const decoded = JSON.parse(new TextDecoder().decode(plain));
          scene.elements = mergeElements(scene.elements, decoded.elements || []);
          if (decoded.appState) scene.appState = { ...scene.appState, ...decoded.appState };
          if (!firstFit) { firstFit = true; fitToBounds(sceneBounds(), false); }
          needsDraw = true;
          post({ type: "collab-loaded", title: decoded.title || "", rawJson: JSON.stringify(scene) });
          const fids = new Set(decoded.fileIds || []);
          for (const el of decoded.elements || []) if (el.fileId) fids.add(el.fileId);
          if (fids.size) void downloadFiles([...fids]);
        } catch (_) {}
      } else if (msg.type === "awareness") {
        try {
          const plain = await decryptBytes(fromB64Url(msg.payload), key);
          const aw = JSON.parse(new TextDecoder().decode(plain));
          collaborators.set(msg.from, aw);
          needsDraw = true;
        } catch (_) {}
      } else if (msg.type === "file-notify") {
        if (Array.isArray(msg.fileIds)) void downloadFiles(msg.fileIds);
      }
    };

    ws.onerror = () => post({ type: "collab-error", error: "WebSocket connection failed" });
  }

  window.__excalidesk = {
    loadScene(rawJson) {
      try {
        const parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
        scene = {
          elements: Array.isArray(parsed.elements) ? parsed.elements : [],
          appState: parsed.appState || { viewBackgroundColor: "#ffffff" },
          files: parsed.files || {},
        };
        imageCache.clear();
        fitToBounds(sceneBounds(), false);
        post({ type: "ready" });
      } catch (e) {
        post({ type: "error", error: String(e) });
      }
    },
    setTheme(dark) {
      isDark = !!dark;
      document.body.className = isDark ? "dark" : "";
      document.body.style.background = isDark ? "#121212" : "#ffffff";
      needsDraw = true;
    },
    fit() {
      fitToBounds(sceneBounds(), true);
    },
    focusBounds(bounds) {
      fitToBounds(bounds, true);
    },
    openCollab(cfg) {
      void openCollab(cfg);
    },
  };

  post({ type: "booted" });
})();
</script>
</body>
</html>`;
}
