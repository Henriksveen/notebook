import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { attemptBackup, type BackupResult } from "./backup.ts";
import { DEFAULT_PORT, entryUrl } from "./config.ts";
import { NotebookError } from "./errors.ts";
import { type ParsedEntry, serializeEntry } from "./frontmatter.ts";
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
import { withWriteLock } from "./lock.ts";
import { assertSafePath, entryFilePath, lstatOrNull } from "./paths.ts";
import { sha256Hex } from "./revision.ts";
import {
  type ArchivedFrom,
  type Attachment,
  describeErrors,
  type Entry,
  MAX_ATTACHMENT_BYTES,
  type Status,
  type Validation,
} from "./schema.ts";
import { type SecretFinding, scanAttachment, scanEntry } from "./secrets.ts";
import {
  applyUpdate,
  buildNewEntry,
  type LoadedEntry,
  readEntry,
} from "./store.ts";

export interface OperationOptions {
  port?: number;
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

export interface MutationResult {
  id: string;
  title: string;
  status: Status;
  url: string;
  revision: string;
  commit: string;
  backup: BackupResult;
  warnings: string[];
}

export interface AttachmentOptions extends OperationOptions {
  name?: string;
}

interface NewFile {
  path: string;
  bytes: Uint8Array;
}

interface Plan {
  entry: ParsedEntry;
  attachments: NewFile[];
}

type Transition = "ready" | "archive" | "restore";

const README = `# Notebook

Entries live in entries/ and attachments in attachments/. Change them through the notebook CLI, not by hand.
`;
const GITIGNORE = ".notebook/\n";
const MEDIA_TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["pdf", "application/pdf"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["html", "text/html"],
]);
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const DEFAULT_EXTENSION = "bin";
const MAX_EXTENSION = 16;
const encoder = new TextEncoder();

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
  const readme = await lstatOrNull(join(root, "README.md"));
  if (!readme?.isFile()) return false;
  const top = await repoTopLevel(root);
  return top !== undefined && (await realpath(top)) === (await realpath(root));
}

export async function assertNotebook(dir: string): Promise<void> {
  if (!(await isNotebook(dir))) {
    throw new NotebookError(
      "NOT_A_NOTEBOOK",
      `${dir} is not a notebook; run init first`,
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
  await commitPaths(root, ["README.md", ".gitignore"], "notebook: init");
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

export async function createEntry(
  dir: string,
  input: unknown,
  options: OperationOptions = {},
): Promise<MutationResult> {
  return transact(dir, "create", options, () => ({
    entry: invalid(buildNewEntry(input)),
    attachments: [],
  }));
}

export function updateEntry(
  dir: string,
  id: string,
  expectedRevision: string,
  patch: unknown,
  options: OperationOptions = {},
): Promise<MutationResult> {
  return changeEntry(
    dir,
    id,
    expectedRevision,
    "update",
    options,
    (current) => ({
      entry: invalid(applyUpdate(current, patch)),
      attachments: [],
    }),
  );
}

export function markReady(
  dir: string,
  id: string,
  expectedRevision: string,
  options: OperationOptions = {},
): Promise<MutationResult> {
  return changeEntry(dir, id, expectedRevision, "ready", options, (current) =>
    transitionPlan(current, "ready"),
  );
}

export function archiveEntry(
  dir: string,
  id: string,
  expectedRevision: string,
  options: OperationOptions = {},
): Promise<MutationResult> {
  return changeEntry(dir, id, expectedRevision, "archive", options, (current) =>
    transitionPlan(current, "archive"),
  );
}

export function restoreEntry(
  dir: string,
  id: string,
  expectedRevision: string,
  options: OperationOptions = {},
): Promise<MutationResult> {
  return changeEntry(dir, id, expectedRevision, "restore", options, (current) =>
    transitionPlan(current, "restore"),
  );
}

export async function addAttachment(
  dir: string,
  id: string,
  expectedRevision: string,
  sourcePath: string,
  options: AttachmentOptions = {},
): Promise<MutationResult & { attachment: Attachment }> {
  let added: Attachment | undefined;
  const result = await changeEntry(
    dir,
    id,
    expectedRevision,
    "attach",
    options,
    async (current) => {
      const plan = await attachmentPlan(current, sourcePath, options.name);
      added = plan.entry.entry.attachments.at(-1);
      return plan;
    },
  );
  if (!added) throw new Error("attachment record missing");
  return { ...result, attachment: added };
}

export async function retryBackup(
  dir: string,
  options: OperationOptions = {},
): Promise<BackupResult> {
  await assertNotebook(dir);
  return withWriteLock(
    dir,
    async () => {
      await repoState(dir);
      return attemptBackup(dir, { pushTimeoutMs: options.pushTimeoutMs });
    },
    { timeoutMs: options.lockTimeoutMs },
  );
}

async function changeEntry(
  dir: string,
  id: string,
  expectedRevision: string,
  action: string,
  options: OperationOptions,
  build: (current: LoadedEntry) => Plan | Promise<Plan>,
): Promise<MutationResult> {
  return transact(dir, action, options, async () =>
    build(await loadExpected(dir, id, expectedRevision)),
  );
}

async function loadExpected(
  dir: string,
  id: string,
  expectedRevision: string,
): Promise<LoadedEntry> {
  await assertNotDirty(dir, [relative(dir, entryFilePath(dir, id))]);
  const current = await readEntry(dir, id);
  if (current.revision !== expectedRevision) {
    throw new NotebookError(
      "STALE_REVISION",
      "the entry changed since it was read; reread it and retry",
      { current_revision: current.revision },
    );
  }
  return current;
}

async function transact(
  dir: string,
  action: string,
  options: OperationOptions,
  plan: () => Plan | Promise<Plan>,
): Promise<MutationResult> {
  await assertNotebook(dir);
  return withWriteLock(
    dir,
    () => commitTransaction(dir, action, options, plan),
    { timeoutMs: options.lockTimeoutMs },
  );
}

async function commitTransaction(
  dir: string,
  action: string,
  options: OperationOptions,
  plan: () => Plan | Promise<Plan>,
): Promise<MutationResult> {
  await repoState(dir);
  const next = await plan();
  const { files, revision } = renderFiles(next);
  const paths = files.map((file) => file.path);
  await assertNotDirty(dir, paths);
  const warnings = await otherDirtyPaths(dir, paths);
  await writeFiles(dir, files);
  const { entry } = next.entry;
  const commit = await commitOrFail(
    dir,
    paths,
    `notebook: ${action} ${entry.id} ${entry.title}`,
  );
  const backup = await attemptBackup(dir, {
    pushTimeoutMs: options.pushTimeoutMs,
  });
  return {
    id: entry.id,
    title: entry.title,
    status: entry.status,
    url: entryUrl(entry.id, options.port ?? DEFAULT_PORT),
    revision,
    commit,
    backup,
    warnings,
  };
}

function invalid<T>(result: Validation<T>): T {
  if (!result.ok) {
    throw new NotebookError(
      "VALIDATION_FAILED",
      describeErrors(result.errors),
      { errors: result.errors },
    );
  }
  return result.value;
}

function renderFiles(plan: Plan): { files: NewFile[]; revision: string } {
  const text = invalid(serializeEntry(plan.entry));
  assertNoSecrets(scanEntry(plan.entry.entry, plan.entry.body));
  const bytes = encoder.encode(text);
  const path = join("entries", `${plan.entry.entry.id}.md`);
  return {
    files: [...plan.attachments, { path, bytes }],
    revision: sha256Hex(bytes),
  };
}

function assertNoSecrets(findings: SecretFinding[]): void {
  if (findings.length === 0) return;
  throw new NotebookError(
    "SECRET_DETECTED",
    "possible secret found; nothing was written",
    { findings },
  );
}

async function assertNotDirty(dir: string, paths: string[]): Promise<void> {
  const dirty = await dirtyPaths(dir, paths);
  if (dirty.length === 0) return;
  throw new NotebookError(
    "DIRTY_TARGET",
    "the target has uncommitted changes; commit or discard them first",
    { paths: dirty },
  );
}

async function otherDirtyPaths(
  dir: string,
  targets: string[],
): Promise<string[]> {
  const dirty = await dirtyPaths(dir, ["entries", "attachments"]);
  return dirty
    .filter((path) => !targets.includes(path))
    .map(
      (path) => `uncommitted change not included in this operation: ${path}`,
    );
}

async function writeFiles(dir: string, files: NewFile[]): Promise<void> {
  for (const file of files) {
    const target = join(dir, file.path);
    await assertSafePath(dir, target);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await atomicWrite(target, file.bytes);
  }
}

async function commitOrFail(
  dir: string,
  paths: string[],
  message: string,
): Promise<string> {
  try {
    await commitPaths(dir, paths, message);
  } catch {
    throw new NotebookError(
      "COMMIT_FAILED",
      "the files were written but the git commit failed; nothing was deleted or reverted",
      { paths, recovery: recoveryInstructions(dir, paths) },
    );
  }
  const commit = await headCommit(dir);
  if (commit === undefined) {
    throw new NotebookError(
      "INTERNAL",
      "commit succeeded but HEAD is unreadable",
    );
  }
  return commit;
}

function recoveryInstructions(dir: string, paths: string[]): string {
  const list = paths.join(" ");
  return `Review with: git -C ${dir} status. To keep the change: git -C ${dir} add -- ${list} && git -C ${dir} commit -m "notebook: recover" -- ${list}. To discard it, restore the paths from git after review.`;
}

function transitionPlan(current: LoadedEntry, action: Transition): Plan {
  const entry = transitioned(current.entry, action);
  entry.updated_at = new Date().toISOString();
  return { entry: { entry, body: current.body }, attachments: [] };
}

function transitioned(entry: Entry, action: Transition): Entry {
  if (action === "ready") {
    requireStatus(entry, ["draft"], action);
    return { ...entry, status: "ready" };
  }
  if (action === "archive") {
    requireStatus(entry, ["draft", "ready"], action);
    const from: ArchivedFrom = entry.status === "ready" ? "ready" : "draft";
    return { ...entry, status: "archived", archived_from: from };
  }
  requireStatus(entry, ["archived"], action);
  if (entry.archived_from === undefined) {
    throw new NotebookError("INTERNAL", "archived entry has no archived_from");
  }
  const restored: Entry = { ...entry, status: entry.archived_from };
  delete restored.archived_from;
  return restored;
}

function requireStatus(
  entry: Entry,
  allowed: Status[],
  action: Transition,
): void {
  if (allowed.includes(entry.status)) return;
  throw new NotebookError(
    "INVALID_TRANSITION",
    `cannot ${action} an entry whose status is ${entry.status}`,
  );
}

async function attachmentPlan(
  current: LoadedEntry,
  sourcePath: string,
  name: string | undefined,
): Promise<Plan> {
  const bytes = await readSource(sourcePath);
  const filename = name ?? basename(sourcePath);
  assertNoSecrets(scanAttachment(filename, bytes));
  const attachmentId = randomUUID();
  const storedAs = `${attachmentId}.${extensionOf(filename)}`;
  const record: Attachment = {
    id: attachmentId,
    filename,
    stored_as: storedAs,
    media_type: mediaTypeOf(storedAs),
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  };
  const entry: Entry = {
    ...current.entry,
    attachments: [...current.entry.attachments, record],
    updated_at: new Date().toISOString(),
  };
  return {
    entry: { entry, body: current.body },
    attachments: [
      {
        path: join("attachments", current.entry.id, storedAs),
        bytes,
      },
    ],
  };
}

async function readSource(path: string): Promise<Uint8Array> {
  const info = await lstatOrNull(path);
  if (!info) throw new NotebookError("NOT_FOUND", "source file not found");
  assertSourceStats(info);
  const handle = await openSource(path);
  try {
    assertSourceStats(await handle.stat());
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function openSource(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrorCode(error, "ELOOP")) {
      throw new NotebookError(
        "UNSAFE_PATH",
        "source must not be a symbolic link",
      );
    }
    throw error;
  }
}

function assertSourceStats(info: Stats): void {
  if (!info.isFile()) {
    throw new NotebookError(
      "UNSAFE_PATH",
      "source must be a regular file (not a symlink, directory, or device)",
    );
  }
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new NotebookError(
      "ATTACHMENT_TOO_LARGE",
      "attachments may be at most 20 MiB",
    );
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function extensionOf(filename: string): string {
  const ext = extname(filename)
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, MAX_EXTENSION);
  return ext || DEFAULT_EXTENSION;
}

function mediaTypeOf(storedAs: string): string {
  const ext = extname(storedAs).slice(1);
  return MEDIA_TYPES.get(ext) ?? DEFAULT_MEDIA_TYPE;
}
