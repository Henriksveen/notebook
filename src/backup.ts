import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { atomicWrite } from "./fsutil.ts";
import {
  changedNotebookFiles,
  hasRemote,
  push,
  readBlob,
  unpublishedCommits,
} from "./git.ts";
import { runtimeDir } from "./lock.ts";
import { scanAttachment, scanText } from "./secrets.ts";

export type BackupStatus = "pushed" | "pending" | "blocked";
export type BackupReason =
  | "no_remote"
  | "push_failed"
  | "timeout"
  | "secret_in_unpublished_commit";

export interface BackupResult {
  status: BackupStatus;
  reason?: BackupReason;
}

export interface BackupState extends BackupResult {
  attempted_at: string;
}

export interface BackupOptions {
  pushTimeoutMs?: number;
}

const PUSH_TIMEOUT_MS = 10_000;
const STATE_FILE = "backup-state.json";

export async function attemptBackup(
  dir: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const result = await evaluateBackup(
    dir,
    options.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
  );
  await writeBackupState(dir, result);
  return result;
}

async function evaluateBackup(
  dir: string,
  timeoutMs: number,
): Promise<BackupResult> {
  if (!(await hasRemote(dir))) {
    return { status: "pending", reason: "no_remote" };
  }
  if (await hasSecretInUnpublished(dir)) {
    return { status: "blocked", reason: "secret_in_unpublished_commit" };
  }
  const outcome = await push(dir, timeoutMs);
  return outcome.ok
    ? { status: "pushed" }
    : { status: "pending", reason: outcome.reason };
}

async function hasSecretInUnpublished(dir: string): Promise<boolean> {
  try {
    for (const commit of await unpublishedCommits(dir)) {
      for (const path of await changedNotebookFiles(dir, commit)) {
        if (await containsSecret(dir, commit, path)) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

async function containsSecret(
  dir: string,
  commit: string,
  path: string,
): Promise<boolean> {
  const bytes = await readBlob(dir, commit, path);
  const findings = path.startsWith("entries/")
    ? scanText(bytes.toString("utf8"), path)
    : scanAttachment(basename(path), bytes);
  return findings.length > 0;
}

export async function writeBackupState(
  dir: string,
  result: BackupResult,
): Promise<void> {
  const runtime = runtimeDir(dir);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const state: BackupState = {
    ...result,
    attempted_at: new Date().toISOString(),
  };
  await atomicWrite(
    join(runtime, STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function readBackupState(
  dir: string,
): Promise<BackupState | null> {
  try {
    return JSON.parse(
      await readFile(join(runtimeDir(dir), STATE_FILE), "utf8"),
    ) as BackupState;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
