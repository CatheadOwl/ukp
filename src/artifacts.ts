import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ArtifactRunOptions {
  root?: string;
  runId?: string;
  now?: Date;
}

export interface ArtifactRun {
  root: string;
  runId: string;
  directory: string;
}

export function defaultArtifactRoot(): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    return resolve(localAppData ?? join(homedir(), "AppData", "Local"), "ukp", "artifacts");
  }
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return resolve(cacheRoot, "ukp", "artifacts");
}

function makeRunId(now: Date): string {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function cleanupExpiredRuns(root: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }

  for (const name of names) {
    const candidate = join(root, name);
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory() && now.getTime() - stat.mtimeMs > RETENTION_MS) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Cleanup is best-effort and must not block the current search.
    }
  }
}

export function createArtifactRun(options: ArtifactRunOptions = {}): ArtifactRun {
  const now = options.now ?? new Date();
  const root = resolve(options.root ?? defaultArtifactRoot());
  const runId = options.runId ?? makeRunId(now);
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error(`invalid artifact run id '${runId}'`);
  }

  mkdirSync(root, { recursive: true, mode: 0o700 });
  cleanupExpiredRuns(root, now);
  const directory = join(root, runId);
  mkdirSync(directory, { recursive: false, mode: 0o700 });

  if (!isAbsolute(directory)) throw new Error("artifact directory must be absolute");
  return { root, runId, directory };
}
