import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SAFE_ID = /^[A-Za-z0-9_-]{6,80}$/;

export function isValidId(id: string): boolean {
  return SAFE_ID.test(id);
}

export function generateId(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

export interface StorageOptions {
  dataDir: string;
  /** Share/room retention in milliseconds; 0 disables expiration cleanup */
  ttlMs: number;
}

/**
 * Disk-backed storage for opaque end-to-end encrypted blobs:
 * - shares/<shareId>.bin           (read-only snapshot links)
 * - rooms/<roomId>/snapshot.bin    (latest encrypted scene for late joiners)
 * - rooms/<roomId>/files/<fileId>.bin (encrypted binary image attachments)
 *
 * The server never holds decryption keys and only stores ciphertext bytes.
 */
export class BlobStorage {
  private readonly sharesDir: string;
  private readonly roomsDir: string;
  private readonly ttlMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(opts: StorageOptions) {
    this.sharesDir = join(opts.dataDir, "shares");
    this.roomsDir = join(opts.dataDir, "rooms");
    this.ttlMs = opts.ttlMs;
    mkdirSync(this.sharesDir, { recursive: true });
    mkdirSync(this.roomsDir, { recursive: true });
  }

  startCleanup(intervalMs = 60 * 60 * 1000): void {
    if (this.ttlMs <= 0) return;
    this.cleanupTimer = setInterval(() => this.pruneExpired(), intervalMs);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private atomicWrite(filePath: string, data: Buffer): void {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
  }

  putShare(data: Buffer, customId?: string): string {
    const id = customId && isValidId(customId) ? customId : generateId(12);
    this.atomicWrite(join(this.sharesDir, `${id}.bin`), data);
    return id;
  }

  getShare(id: string): Buffer | null {
    if (!isValidId(id)) return null;
    const p = join(this.sharesDir, `${id}.bin`);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  putRoomSnapshot(roomId: string, data: Buffer): boolean {
    if (!isValidId(roomId)) return false;
    const dir = join(this.roomsDir, roomId);
    mkdirSync(dir, { recursive: true });
    this.atomicWrite(join(dir, "snapshot.bin"), data);
    return true;
  }

  getRoomSnapshot(roomId: string): Buffer | null {
    if (!isValidId(roomId)) return null;
    const p = join(this.roomsDir, roomId, "snapshot.bin");
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  putRoomFile(roomId: string, fileId: string, data: Buffer): boolean {
    if (!isValidId(roomId) || !isValidId(fileId)) return false;
    const dir = join(this.roomsDir, roomId, "files");
    mkdirSync(dir, { recursive: true });
    this.atomicWrite(join(dir, `${fileId}.bin`), data);
    return true;
  }

  getRoomFile(roomId: string, fileId: string): Buffer | null {
    if (!isValidId(roomId) || !isValidId(fileId)) return null;
    const p = join(this.roomsDir, roomId, "files", `${fileId}.bin`);
    if (!existsSync(p)) return null;
    try {
      return readFileSync(p);
    } catch {
      return null;
    }
  }

  pruneExpired(now = Date.now()): { sharesRemoved: number; roomsRemoved: number } {
    if (this.ttlMs <= 0) return { sharesRemoved: 0, roomsRemoved: 0 };
    const cutoff = now - this.ttlMs;
    let sharesRemoved = 0;
    let roomsRemoved = 0;

    if (existsSync(this.sharesDir)) {
      for (const name of readdirSync(this.sharesDir)) {
        const p = join(this.sharesDir, name);
        try {
          if (statSync(p).mtimeMs < cutoff) {
            unlinkSync(p);
            sharesRemoved++;
          }
        } catch {
          // ignore race
        }
      }
    }

    if (existsSync(this.roomsDir)) {
      for (const name of readdirSync(this.roomsDir)) {
        const dir = join(this.roomsDir, name);
        try {
          const snap = join(dir, "snapshot.bin");
          const target = existsSync(snap) ? snap : dir;
          if (statSync(target).mtimeMs < cutoff) {
            rmSync(dir, { recursive: true, force: true });
            roomsRemoved++;
          }
        } catch {
          // ignore race
        }
      }
    }

    return { sharesRemoved, roomsRemoved };
  }
}
