import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { NotebookError } from "./errors.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function resolveDataDir(
  options: {
    flag?: string;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {},
): string {
  const raw = options.flag || (options.env ?? process.env).NOTEBOOK_DIR;
  if (raw) return resolve(raw);
  return join(options.home ?? homedir(), "notebook");
}

export function entryFilePath(root: string, id: string): string {
  if (!isValidId(id))
    throw new NotebookError("USAGE", "invalid entry id: must be a UUID v4");
  return join(root, "entries", `${id}.md`);
}

export function attachmentFilePath(
  root: string,
  entryId: string,
  storedAs: string,
): string {
  if (!isValidId(entryId))
    throw new NotebookError("USAGE", "invalid entry id: must be a UUID v4");
  if (!SAFE_SEGMENT.test(storedAs) || storedAs.includes("..")) {
    throw new NotebookError("UNSAFE_PATH", "unsafe attachment file name");
  }
  return join(root, "attachments", entryId, storedAs);
}

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel.split(sep)[0] !== ".." && !rel.startsWith(sep);
}

export async function assertSafePath(
  root: string,
  target: string,
): Promise<void> {
  if (!isInside(root, target)) {
    throw new NotebookError(
      "UNSAFE_PATH",
      "path escapes the notebook directory",
    );
  }
  let current = root;
  for (const part of relative(root, target).split(sep)) {
    current = join(current, part);
    const info = await lstatOrNull(current);
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new NotebookError(
        "UNSAFE_PATH",
        "symbolic links are not allowed in the notebook",
      );
    }
  }
}
