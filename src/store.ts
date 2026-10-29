import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NotebookError } from "./errors.ts";
import { ENTRY_LIMIT, type ParsedEntry, parseEntry } from "./frontmatter.ts";
import {
  assertSafePath,
  entryFilePath,
  isValidId,
  lstatOrNull,
} from "./paths.ts";
import { sha256Hex } from "./revision.ts";
import {
  describeErrors,
  type Entry,
  SCHEMA_VERSION,
  type Validation,
  validateEntryInput,
  validateEntryPatch,
} from "./schema.ts";

export interface LoadedEntry extends ParsedEntry {
  revision: string;
  path: string;
}

export interface LoadWarning {
  path: string;
  message: string;
}

export interface ListResult {
  entries: LoadedEntry[];
  warnings: LoadWarning[];
}

export async function listEntries(dir: string): Promise<ListResult> {
  const entriesDir = join(dir, "entries");
  await assertSafePath(dir, entriesDir);
  if (!(await lstatOrNull(entriesDir))) return { entries: [], warnings: [] };
  const entries: LoadedEntry[] = [];
  const warnings: LoadWarning[] = [];
  for (const name of (await readdir(entriesDir)).sort()) {
    const path = join("entries", name);
    const id = name.endsWith(".md") ? name.slice(0, -3) : name;
    if (!isValidId(id)) {
      warnings.push({ path, message: "skipped: not an entry file name" });
      continue;
    }
    try {
      entries.push(await loadEntry(dir, id, join(entriesDir, name)));
    } catch (error) {
      if (!(error instanceof NotebookError)) throw error;
      warnings.push({ path, message: `skipped: ${error.message}` });
    }
  }
  return { entries, warnings };
}

export async function readEntry(dir: string, id: string): Promise<LoadedEntry> {
  return loadEntry(dir, id, entryFilePath(dir, id));
}

async function loadEntry(
  dir: string,
  id: string,
  file: string,
): Promise<LoadedEntry> {
  await assertSafePath(dir, file);
  const info = await lstatOrNull(file);
  if (!info) throw new NotebookError("NOT_FOUND", `entry ${id} not found`);
  if (!info.isFile())
    throw new NotebookError("UNSAFE_PATH", "entry is not a regular file");
  if (info.size > ENTRY_LIMIT)
    throw new NotebookError("VALIDATION_FAILED", "entry exceeds 2 MiB");
  const bytes = await readFile(file);
  const parsed = parseEntry(bytes);
  if (!parsed.ok) {
    throw new NotebookError(
      "VALIDATION_FAILED",
      `invalid entry: ${describeErrors(parsed.errors)}`,
      {
        errors: parsed.errors,
      },
    );
  }
  if (parsed.value.entry.id !== id) {
    throw new NotebookError(
      "VALIDATION_FAILED",
      "invalid entry: id does not match file name",
    );
  }
  return { ...parsed.value, revision: sha256Hex(bytes), path: file };
}

export interface NewEntryOptions {
  id?: string;
  now?: Date;
}

export function buildNewEntry(
  input: unknown,
  options: NewEntryOptions = {},
): Validation<ParsedEntry> {
  const checked = validateEntryInput(input);
  if (!checked.ok) return checked;
  const { body, ...fields } = checked.value;
  const stamp = (options.now ?? new Date()).toISOString();
  const entry: Entry = {
    schema_version: SCHEMA_VERSION,
    id: options.id ?? randomUUID(),
    ...fields,
    created_at: stamp,
    updated_at: stamp,
    status: "draft",
    attachments: [],
  };
  return { ok: true, value: { entry, body } };
}

export function applyUpdate(
  current: ParsedEntry,
  patch: unknown,
  now: Date = new Date(),
): Validation<ParsedEntry> {
  const checked = validateEntryPatch(patch);
  if (!checked.ok) return checked;
  const { body, ...fields } = checked.value;
  return {
    ok: true,
    value: {
      entry: { ...current.entry, ...fields, updated_at: now.toISOString() },
      body: body ?? current.body,
    },
  };
}
