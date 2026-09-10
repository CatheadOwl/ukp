import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { parse } from "smol-toml";

export class LockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LockError";
  }
}

export class LockBusyError extends LockError {
  constructor(path: string) {
    super(`lock_busy: ${path}`);
    this.name = "LockBusyError";
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function processExists(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  try {
    const metadata = parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    if (metadata.hostname !== hostname()) return false;
    if (typeof metadata.pid !== "number" || !Number.isSafeInteger(metadata.pid)) return false;
    if (typeof metadata.created_at !== "string") return false;
    const createdAt = Date.parse(metadata.created_at);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt <= 10 * 60 * 1000) return false;
    if (processExists(metadata.pid) !== false) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// Write-discipline sibling lock: exclusive create with owner metadata, stale
// reclamation (same host, >10min old, dead pid), bounded retry.
export function acquireLock(lockPath: string): number {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(
          descriptor,
          `pid = ${process.pid}\nhostname = ${JSON.stringify(hostname())}\ncreated_at = ${JSON.stringify(new Date().toISOString())}\ntoken = ${JSON.stringify(randomUUID())}\n`,
          "utf8",
        );
        fsyncSync(descriptor);
        return descriptor;
      } catch (error) {
        closeSync(descriptor);
        if (existsSync(lockPath)) unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && reclaimStaleLock(lockPath)) {
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LockBusyError(lockPath);
        throw new LockError(`cannot acquire lock: ${lockPath}`, { cause: error });
      }
      sleep(25);
    }
  }
}

export function releaseLock(lockPath: string, descriptor: number): void {
  closeSync(descriptor);
  if (existsSync(lockPath)) unlinkSync(lockPath);
}
