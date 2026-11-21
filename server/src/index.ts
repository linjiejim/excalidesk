import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createExcalideskServer } from "./app.js";

const port = Number(process.env.PORT ?? 3456);
const host = process.env.HOST ?? "0.0.0.0";
const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const maxBodyMb = Number(process.env.MAX_BODY_MB ?? 25);
const ttlDays = Number(process.env.SHARE_TTL_DAYS ?? 30);
const corsOrigin = process.env.CORS_ORIGIN ?? "*";

const defaultStatic = [
  resolve(import.meta.dirname, "../../../dist"),
  resolve(import.meta.dirname, "../web"),
].find((p) => existsSync(p));
const staticDir = process.env.STATIC_DIR ? resolve(process.env.STATIC_DIR) : defaultStatic;

const server = createExcalideskServer({
  dataDir,
  staticDir,
  corsOrigin,
  maxBodyBytes: maxBodyMb * 1024 * 1024,
  ttlDays,
});

const bound = await server.listen(port, host);
console.log(
  `Excalidesk collab server listening on http://${bound.host}:${bound.port}` +
    ` (data: ${dataDir}${staticDir ? `, web: ${staticDir}` : ", web: none"})`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
