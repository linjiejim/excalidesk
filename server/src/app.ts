import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { BlobStorage, isValidId } from "./storage.js";
import { RoomHub } from "./rooms.js";

export interface ServerConfig {
  dataDir: string;
  staticDir?: string;
  corsOrigin?: string;
  maxBodyBytes?: number;
  ttlDays?: number;
  heartbeatMs?: number;
}

export interface ExcalideskServer {
  httpServer: Server;
  wss: WebSocketServer;
  storage: BlobStorage;
  hub: RoomHub;
  listen: (port: number, host?: string) => Promise<{ port: number; host: string }>;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".excalidraw": "application/vnd.excalidraw+json",
};

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendBinary(res: ServerResponse, status: number, body: Buffer, cache = "no-store"): void {
  res.writeHead(status, {
    "Content-Type": "application/octet-stream",
    "Content-Length": body.byteLength,
    "Cache-Control": cache,
  });
  res.end(body);
}

export function createExcalideskServer(config: ServerConfig): ExcalideskServer {
  const corsOrigin = config.corsOrigin ?? "*";
  const maxBodyBytes = config.maxBodyBytes ?? 25 * 1024 * 1024;
  const ttlMs = (config.ttlDays ?? 30) * 24 * 60 * 60 * 1000;
  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined;

  const storage = new BlobStorage({ dataDir: config.dataDir, ttlMs });
  storage.startCleanup();
  const hub = new RoomHub({
    storage,
    maxMessageBytes: Math.min(maxBodyBytes, 8 * 1024 * 1024),
    heartbeatMs: config.heartbeatMs,
  });

  const applyCors = (res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", corsOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  const serveStatic = (pathname: string, res: ServerResponse): boolean => {
    if (!staticDir || !existsSync(staticDir)) return false;
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
    let candidate = resolve(staticDir, safe);
    if (!candidate.startsWith(staticDir)) return false;

    if (!existsSync(candidate) || statSync(candidate).isDirectory()) {
      // SPA fallback to index.html for routes without a file extension
      if (!extname(pathname)) {
        candidate = join(staticDir, "index.html");
        if (!existsSync(candidate)) return false;
      } else {
        return false;
      }
    }

    const ext = extname(candidate).toLowerCase();
    const content = readFileSync(candidate);
    const cache = ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable";
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": content.byteLength,
      "Cache-Control": cache,
    });
    res.end(content);
    return true;
  };

  const httpServer = createServer(async (req, res) => {
    applyCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      // Health check
      if (req.method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          service: "excalidesk-server",
          e2ee: true,
          ...hub.stats(),
        });
        return;
      }

      // Create read-only encrypted share snapshot
      if (req.method === "POST" && pathname === "/api/shares") {
        const body = await readBody(req, maxBodyBytes);
        if (body.byteLength === 0) {
          sendJson(res, 400, { error: "empty_body" });
          return;
        }
        const id = storage.putShare(body);
        sendJson(res, 201, { id, bytes: body.byteLength });
        return;
      }

      // Fetch read-only encrypted share snapshot
      const shareMatch = pathname.match(/^\/api\/shares\/([^/]+)$/);
      if (req.method === "GET" && shareMatch) {
        const id = decodeURIComponent(shareMatch[1]);
        if (!isValidId(id)) {
          sendJson(res, 400, { error: "invalid_id" });
          return;
        }
        const data = storage.getShare(id);
        if (!data) {
          sendJson(res, 404, { error: "not_found" });
          return;
        }
        sendBinary(res, 200, data, "public, max-age=86400");
        return;
      }

      // Room encrypted snapshot (PUT / GET)
      const snapMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/snapshot$/);
      if (snapMatch) {
        const roomId = decodeURIComponent(snapMatch[1]);
        if (!isValidId(roomId)) {
          sendJson(res, 400, { error: "invalid_room_id" });
          return;
        }
        if (req.method === "PUT") {
          const body = await readBody(req, maxBodyBytes);
          if (body.byteLength === 0) {
            sendJson(res, 400, { error: "empty_body" });
            return;
          }
          storage.putRoomSnapshot(roomId, body);
          sendJson(res, 200, { ok: true, bytes: body.byteLength });
          return;
        }
        if (req.method === "GET") {
          const data = storage.getRoomSnapshot(roomId);
          if (!data) {
            sendJson(res, 404, { error: "not_found" });
            return;
          }
          sendBinary(res, 200, data);
          return;
        }
      }

      // Room encrypted binary files (images)
      const fileMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/files\/([^/]+)$/);
      if (fileMatch) {
        const roomId = decodeURIComponent(fileMatch[1]);
        const fileId = decodeURIComponent(fileMatch[2]);
        if (!isValidId(roomId) || !isValidId(fileId)) {
          sendJson(res, 400, { error: "invalid_id" });
          return;
        }
        if (req.method === "PUT") {
          const body = await readBody(req, maxBodyBytes);
          if (body.byteLength === 0) {
            sendJson(res, 400, { error: "empty_body" });
            return;
          }
          storage.putRoomFile(roomId, fileId, body);
          sendJson(res, 200, { ok: true, bytes: body.byteLength });
          return;
        }
        if (req.method === "GET") {
          const data = storage.getRoomFile(roomId, fileId);
          if (!data) {
            sendJson(res, 404, { error: "not_found" });
            return;
          }
          sendBinary(res, 200, data, "public, max-age=31536000, immutable");
          return;
        }
      }

      // Static web client
      if (req.method === "GET" || req.method === "HEAD") {
        if (serveStatic(pathname, res)) return;
      }

      sendJson(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof Error && err.message === "payload_too_large") {
        if (!res.headersSent) sendJson(res, 413, { error: "payload_too_large" });
        return;
      }
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => hub.handleConnection(ws));

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const listen = (port: number, host = "0.0.0.0") =>
    new Promise<{ port: number; host: string }>((resolveListen, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        const addr = httpServer.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolveListen({ port: actualPort, host });
      });
    });

  const close = () =>
    new Promise<void>((resolveClose) => {
      storage.stopCleanup();
      hub.close();
      wss.close(() => {
        httpServer.close(() => resolveClose());
      });
    });

  return { httpServer, wss, storage, hub, listen, close };
}
