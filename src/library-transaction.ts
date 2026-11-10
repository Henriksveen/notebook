import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NotebookError } from "./errors.ts";
import { atomicWrite, syncDirectory } from "./fsutil.ts";
import {
  commitPaths,
  currentBranch,
  dirtyPaths,
  gitBytes,
  headCommit,
  repoState,
} from "./git.ts";
import {
  HTML_LIMIT,
  keys,
  META_LIMIT,
  object,
  TEXT_LIMIT,
} from "./library-schema.ts";
import { type ItemFiles, treeFiles } from "./library-store.ts";
import { assertSafePath, isValidId, lstatOrNull } from "./paths.ts";
import { sha256Hex } from "./revision.ts";
import { scanText } from "./secrets.ts";

interface Journal {
  id: string;
  base: string;
  branch: string;
  files: ItemFiles;
  old: Record<string, string | null>;
}
const JOURNAL = ".notebook/transactions/pending.json";
const ID =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PATH = new RegExp(
  `^(?:pages/${ID}/(?:page\\.yaml|index\\.html|context\\.md)|prompts/${ID}\\.md|\\.notebook-format)$`,
);
const HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export async function scanFiles(files: ItemFiles): Promise<void> {
  for (const [path, bytes] of Object.entries(files)) {
    if (!PATH.test(path))
      throw new NotebookError("UNSAFE_PATH", "invalid publication path");
    if (
      bytes !== null &&
      (typeof bytes !== "string" ||
        Buffer.byteLength(bytes) >
          (path.endsWith("index.html")
            ? HTML_LIMIT
            : path.endsWith("page.yaml")
              ? META_LIMIT
              : path === ".notebook-format"
                ? 100
                : TEXT_LIMIT))
    )
      throw new NotebookError(
        "VALIDATION_FAILED",
        "publication exceeds file limit",
      );
    const findings = bytes === null ? [] : scanText(bytes, path);
    if (findings.length)
      throw new NotebookError(
        "SECRET_DETECTED",
        "possible secret; nothing was written",
        { findings },
      );
  }
}
async function committedFile(
  dir: string,
  commit: string,
  path: string,
): Promise<string | null> {
  const tree = await treeFiles(dir, commit, path);
  if (!tree.has(path)) return null;
  if ((tree.get(path)?.size ?? 0) > HTML_LIMIT)
    throw new NotebookError("REPO_STATE", "recovery file exceeds size limit");
  return (
    await gitBytes(dir, ["cat-file", "blob", `${commit}:${path}`])
  ).toString("utf8");
}
async function workingFile(dir: string, path: string): Promise<string | null> {
  const file = join(dir, path);
  await assertSafePath(dir, file);
  const info = await lstatOrNull(file);
  if (!info) return null;
  if (!info.isFile() || info.size > HTML_LIMIT)
    throw new NotebookError("REPO_STATE", "unsafe recovery target", {
      paths: [path],
    });
  return readFile(file, "utf8");
}
async function indexedFile(dir: string, path: string): Promise<string | null> {
  const record = (
    await gitBytes(dir, ["ls-files", "--stage", "-z", "--", path])
  ).toString("utf8");
  if (!record) return null;
  if (!/^100644 [a-f0-9]+ 0\t[^\0]+\0$/.test(record))
    throw new NotebookError("REPO_STATE", "unsafe staged recovery target", {
      paths: [path],
    });
  return (
    await gitBytes(dir, ["cat-file", "blob", record.split(" ")[1]])
  ).toString("utf8");
}
function hash(bytes: string | null): string | null {
  return bytes === null ? null : sha256Hex(bytes);
}
async function putFile(
  dir: string,
  path: string,
  bytes: string | null,
): Promise<void> {
  const file = join(dir, path);
  await assertSafePath(dir, file);
  if (bytes === null) {
    if (await lstatOrNull(file)) {
      await unlink(file);
      await syncDirectory(dirname(file));
    }
  } else {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, bytes);
  }
}
async function clearJournal(dir: string): Promise<void> {
  const path = join(dir, JOURNAL);
  await unlink(path);
  await syncDirectory(dirname(path));
}
function parseJournal(bytes: string): Journal {
  let raw: Record<string, unknown>;
  try {
    raw = object(JSON.parse(bytes));
  } catch {
    throw new NotebookError("REPO_STATE", "invalid recovery journal");
  }
  keys(raw, ["id", "base", "branch", "files", "old"]);
  if (
    !isValidId(raw.id) ||
    typeof raw.base !== "string" ||
    !HASH.test(raw.base) ||
    typeof raw.branch !== "string" ||
    !raw.branch
  )
    throw new NotebookError("REPO_STATE", "invalid recovery identity");
  const files = object(raw.files),
    old = object(raw.old);
  if (
    !Object.keys(files).length ||
    Object.keys(files).length > 4 ||
    Object.keys(old).length !== Object.keys(files).length
  )
    throw new NotebookError("REPO_STATE", "invalid recovery paths");
  for (const [path, value] of Object.entries(files)) {
    if (
      !PATH.test(path) ||
      !Object.hasOwn(old, path) ||
      (value !== null && typeof value !== "string") ||
      (old[path] !== null &&
        (typeof old[path] !== "string" ||
          !/^[a-f0-9]{64}$/.test(old[path] as string)))
    )
      throw new NotebookError("REPO_STATE", "invalid recovery content");
  }
  return raw as unknown as Journal;
}
// Caller holds write.lock. Readers of new items only use committed Git snapshots.
export async function recoverTransaction(dir: string): Promise<void> {
  const path = join(dir, JOURNAL);
  await assertSafePath(dir, path);
  const info = await lstatOrNull(path);
  if (!info) return;
  if (
    !info.isFile() ||
    info.size > 6 * (HTML_LIMIT + TEXT_LIMIT + META_LIMIT) + META_LIMIT
  )
    throw new NotebookError("REPO_STATE", "unsafe recovery journal");
  const journal = parseJournal(await readFile(path, "utf8"));
  await scanFiles(journal.files);
  const head = await headCommit(dir);
  const branch = await currentBranch(dir);
  const paths = Object.keys(journal.files);
  if (branch !== journal.branch || !head)
    throw new NotebookError("REPO_STATE", "branch changed during publication", {
      paths,
    });
  if (head !== journal.base) {
    const message = (
      await gitBytes(dir, ["show", "-s", "--format=%B", head])
    ).toString("utf8");
    const parents = (await gitBytes(dir, ["show", "-s", "--format=%P", head]))
      .toString("utf8")
      .trim();
    if (
      parents !== journal.base ||
      !message.split("\n").includes(`Notebook-Transaction: ${journal.id}`)
    )
      throw new NotebookError(
        "REPO_STATE",
        "HEAD changed during interrupted publication",
        { paths },
      );
    for (const file of paths)
      if ((await committedFile(dir, head, file)) !== journal.files[file])
        throw new NotebookError(
          "REPO_STATE",
          "committed recovery content differs",
          { paths },
        );
    await clearJournal(dir);
    return;
  }
  // Validate every target before rolling any of them back; never discard manual edits.
  for (const file of paths) {
    const expected = [journal.old[file], hash(journal.files[file])];
    if (
      !expected.includes(hash(await workingFile(dir, file))) ||
      !expected.includes(hash(await indexedFile(dir, file)))
    )
      throw new NotebookError(
        "REPO_STATE",
        "recovery target was edited; resolve before writing",
        { paths: [file] },
      );
    if (
      hash(await committedFile(dir, journal.base, file)) !== journal.old[file]
    )
      throw new NotebookError("REPO_STATE", "recovery base differs", {
        paths: [file],
      });
  }
  for (const file of paths)
    await putFile(dir, file, await committedFile(dir, journal.base, file));
  // Path-limited index restoration, not a branch reset; unrelated staged work survives.
  await gitBytes(dir, ["reset", "-q", journal.base, "--", ...paths]);
  await clearJournal(dir);
}
export async function publish(
  dir: string,
  files: ItemFiles,
  message: string,
  options: { boundary?: (step: string) => void } = {},
): Promise<string> {
  await recoverTransaction(dir);
  await repoState(dir);
  await scanFiles(files);
  const paths = Object.keys(files);
  const owners = new Set(
    paths.map((path) =>
      path.startsWith("pages/") ? path.split("/").slice(0, 2).join("/") : path,
    ),
  );
  if (owners.size !== 1)
    throw new NotebookError(
      "VALIDATION_FAILED",
      "one item per publication is required",
    );
  if (!paths.length || paths.length > 4)
    throw new NotebookError("VALIDATION_FAILED", "invalid transaction size");
  const dirty = await dirtyPaths(dir, paths);
  if (dirty.length)
    throw new NotebookError(
      "DIRTY_TARGET",
      "publication targets have uncommitted changes",
      { paths: dirty },
    );
  const base = await headCommit(dir);
  const branch = await currentBranch(dir);
  if (!base || !branch)
    throw new NotebookError("REPO_STATE", "missing publication base");
  const old: Record<string, string | null> = {};
  for (const file of paths) {
    await assertSafePath(dir, join(dir, file));
    old[file] = hash(await committedFile(dir, base, file));
  }
  const journal: Journal = { id: randomUUID(), base, branch, files, old };
  const path = join(dir, JOURNAL);
  await assertSafePath(dir, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWrite(path, JSON.stringify(journal));
  try {
    options.boundary?.("journal");
    for (const [index, file] of paths.entries()) {
      await putFile(dir, file, files[file]);
      options.boundary?.(`write:${index}`);
    }
    await gitBytes(dir, [
      "add",
      "--",
      ...paths.filter((file) => files[file] !== null || old[file] !== null),
    ]);
    options.boundary?.("staged");
    if (
      (await headCommit(dir)) !== base ||
      (await currentBranch(dir)) !== branch
    )
      throw new NotebookError(
        "REPO_STATE",
        "Git state changed during publication",
      );
    // Absent optional files need not exist for git commit --only pathspec validation.
    const changed = paths.filter(
      (file) => files[file] !== null || old[file] !== null,
    );
    try {
      await commitPaths(
        dir,
        changed,
        `${message}\n\nNotebook-Transaction: ${journal.id}`,
        true,
      );
    } catch {
      throw new NotebookError(
        "COMMIT_FAILED",
        "could not commit library change",
      );
    }
    options.boundary?.("committed");
    const commit = await headCommit(dir);
    if (!commit)
      throw new NotebookError("COMMIT_FAILED", "missing committed revision");
    await recoverTransaction(dir);
    return commit;
  } catch (error) {
    await recoverTransaction(dir);
    throw error;
  }
}
