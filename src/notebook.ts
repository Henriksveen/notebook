import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { attemptBackup, type BackupResult, recordBackup } from "./backup.ts";
import { NotebookError } from "./errors.ts";
import { atomicWrite } from "./fsutil.ts";
import {
  addOrigin,
  commitPaths,
  dirtyPaths,
  hasRemote,
  headCommit,
  initRepository,
  repoState,
  repoTopLevel,
} from "./git.ts";
import { recoverTransaction } from "./library-transaction.ts";
import { withWriteLock } from "./lock.ts";
import { lstatOrNull } from "./paths.ts";
export interface OperationOptions {
  lockTimeoutMs?: number;
  pushTimeoutMs?: number;
}
export interface InitOptions {
  remote?: string;
}
export interface InitResult {
  dir: string;
  created: boolean;
  remote: boolean;
  commit: string | undefined;
}
const README = `# Notebook

Visual pages live in pages/ and reusable prompts in prompts/.
Use the notebook CLI to publish changes and preserve their history.
`;
const GITIGNORE = ".notebook/\n";
const FORMAT_MARKER = ".notebook-format";
const FORMAT_CONTENT = "notebook-format 2\n";
export async function initNotebook(
  dir: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const root = resolve(dir);
  if (options.remote !== undefined) validateRemote(options.remote);
  const created = !(await isNotebook(root));
  if (created) await createNotebook(root);
  if (options.remote !== undefined && !(await hasRemote(root))) {
    await addOrigin(root, options.remote);
  }
  return {
    dir: root,
    created,
    remote: await hasRemote(root),
    commit: await headCommit(root),
  };
}

export async function isNotebook(root: string): Promise<boolean> {
  const top = await repoTopLevel(root);
  if (top === undefined || (await realpath(top)) !== (await realpath(root))) {
    return false;
  }
  const marker = await regularFileText(join(root, FORMAT_MARKER));
  const ignore = await regularFileText(join(root, ".gitignore"));
  return (
    marker === FORMAT_CONTENT &&
    ignore !== undefined &&
    ignore.split(/\r?\n/).includes(".notebook/")
  );
}

async function regularFileText(path: string): Promise<string | undefined> {
  const info = await lstatOrNull(path);
  if (!info?.isFile()) return undefined;
  return readFile(path, "utf8");
}

export async function assertNotebook(dir: string): Promise<void> {
  if (!(await isNotebook(dir))) {
    throw new NotebookError(
      "NOT_A_NOTEBOOK",
      `${dir} is not a notebook; run init first`,
    );
  }
  if ((await dirtyPaths(dir, [FORMAT_MARKER])).length) {
    throw new NotebookError(
      "DIRTY_TARGET",
      "format marker has uncommitted changes",
    );
  }
}

function validateRemote(remote: string): void {
  if (remote.trim() === "" || remote.startsWith("-") || /[\r\n]/.test(remote)) {
    throw new NotebookError("USAGE", "remote must be a URL or path");
  }
}

async function createNotebook(root: string): Promise<void> {
  await assertCanCreate(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await initRepository(root);
  await atomicWrite(join(root, "README.md"), README, 0o644);
  await atomicWrite(join(root, ".gitignore"), GITIGNORE, 0o644);
  await atomicWrite(join(root, FORMAT_MARKER), FORMAT_CONTENT, 0o644);
  await commitPaths(
    root,
    ["README.md", ".gitignore", FORMAT_MARKER],
    "notebook: init",
  );
}

async function assertCanCreate(root: string): Promise<void> {
  const info = await lstatOrNull(root);
  if (!info) return;
  if (!info.isDirectory() || (await readdir(root)).length > 0) {
    throw new NotebookError(
      "NOT_A_NOTEBOOK",
      `${root} exists, is not empty, and is not a notebook`,
    );
  }
}

export async function retryBackup(
  dir: string,
  options: OperationOptions = {},
): Promise<{ backup: BackupResult; warnings: string[] }> {
  await assertNotebook(dir);
  return withWriteLock(
    dir,
    async () => {
      await recoverTransaction(dir);
      await assertNotebook(dir);
      await repoState(dir);
      const backup = await attemptBackup(dir, {
        pushTimeoutMs: options.pushTimeoutMs,
      });
      return { backup, warnings: await recordBackup(dir, backup) };
    },
    { timeoutMs: options.lockTimeoutMs },
  );
}
