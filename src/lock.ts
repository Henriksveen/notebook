import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { NotebookError } from "./errors.ts";
import { assertSafePath } from "./paths.ts";

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const LOCK_EXIT_TIMEOUT = 1;
const HOLD_SCRIPT = "echo locked; exec cat";

export interface LockOptions {
  timeoutMs?: number;
}

interface HeldLock {
  child: ChildProcess;
  exited: Promise<number | null>;
}

export function runtimeDir(dir: string): string {
  return join(dir, ".notebook");
}

export async function withWriteLock<T>(
  dir: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockFile = await prepareLockFile(dir);
  const held = await acquire(
    lockFile,
    options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
  );
  try {
    return await fn();
  } finally {
    await release(held);
  }
}

async function prepareLockFile(dir: string): Promise<string> {
  const runtime = runtimeDir(dir);
  await assertSafePath(dir, runtime);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const lockFile = join(runtime, "write.lock");
  await assertSafePath(dir, lockFile);
  const handle = await open(lockFile, "a", 0o600);
  await handle.close();
  return lockFile;
}

function acquire(lockFile: string, timeoutMs: number): Promise<HeldLock> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return new Promise((resolve, reject) => {
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--timeout",
        String(seconds),
        lockFile,
        "sh",
        "-c",
        HOLD_SCRIPT,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const exited = new Promise<number | null>((done) =>
      child.once("close", done),
    );
    child.once("error", () =>
      reject(new NotebookError("INTERNAL", "the flock command is unavailable")),
    );
    exited.then((code) => {
      reject(
        code === LOCK_EXIT_TIMEOUT
          ? new NotebookError("LOCK_TIMEOUT", "another write is in progress")
          : new NotebookError("INTERNAL", "could not acquire the write lock"),
      );
    });
    child.stdout.setEncoding("utf8");
    let output = "";
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.startsWith("locked\n")) resolve({ child, exited });
    });
  });
}

async function release(held: HeldLock): Promise<void> {
  held.child.stdin?.end();
  await held.exited;
}
