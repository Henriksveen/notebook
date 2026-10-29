import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { type CommandName, usage, type Values } from "./args.ts";
import { readBackupState } from "./backup.ts";
import { entryUrl } from "./config.ts";
import { NotebookError } from "./errors.ts";
import { type ParsedEntry, serializeEntry } from "./frontmatter.ts";
import { hasRemote, headCommit, unpublishedCommits } from "./git.ts";
import {
  addAttachment,
  archiveEntry,
  assertNotebook,
  createEntry,
  initNotebook,
  isNotebook,
  type MutationResult,
  markReady,
  restoreEntry,
  retryBackup,
  updateEntry,
} from "./notebook.ts";
import {
  formatBackup,
  formatEntry,
  formatInit,
  formatMutation,
  formatSearch,
  formatStatus,
  type Outcome,
  type StatusData,
} from "./output.ts";
import {
  describeErrors,
  STATUSES,
  type Status,
  type Validation,
} from "./schema.ts";
import { searchNotebook } from "./search.ts";
import { type SecretFinding, scanEntry } from "./secrets.ts";
import { buildNewEntry, readEntry } from "./store.ts";

const INPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface Context {
  dir: string;
  port: number;
  positionals: string[];
  values: Values;
}

type Handler = (context: Context) => Promise<Outcome>;

export const HANDLERS: Record<CommandName, Handler> = {
  init: runInit,
  create: runCreate,
  validate: runValidate,
  search: runSearch,
  read: runRead,
  update: runUpdate,
  ready: runReady,
  archive: runArchive,
  restore: runRestore,
  attach: runAttach,
  status: runStatus,
  backup: runBackup,
};

async function runInit({ dir, values }: Context): Promise<Outcome> {
  const result = await initNotebook(dir, { remote: values.remote });
  return { data: result, warnings: [], text: formatInit(result) };
}

async function runCreate({ dir, port, values }: Context): Promise<Outcome> {
  const input = await readJsonInput(required(values.input, "--input"));
  return mutation(await createEntry(dir, input, { port }), "Created");
}

async function runValidate({
  dir,
  positionals,
  values,
}: Context): Promise<Outcome> {
  if (values.input !== undefined) {
    if (positionals.length > 0) {
      throw usage("validate takes either --input or an ID, not both");
    }
    const parsed = unwrap(buildNewEntry(await readJsonInput(values.input)));
    assertCreatable(parsed);
    return {
      data: { valid: true, title: parsed.entry.title },
      warnings: [],
      text: `Valid input: "${parsed.entry.title}"`,
    };
  }
  if (positionals.length !== 1) {
    throw usage("validate requires --input or an ID");
  }
  await assertNotebook(dir);
  const loaded = await readEntry(dir, positionals[0] ?? "");
  assertNoSecrets(scanEntry(loaded.entry, loaded.body));
  return {
    data: { valid: true, id: loaded.entry.id, revision: loaded.revision },
    warnings: [],
    text: `Valid entry ${loaded.entry.id}`,
  };
}

async function runSearch({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  await assertNotebook(dir);
  const result = await searchNotebook(dir, {
    query: positionals.length > 0 ? positionals.join(" ") : undefined,
    project: values.project,
    topic: values.topic,
    type: values.type,
    status: parseStatus(values.status),
    includeArchived: values["include-archived"],
    limit: parseCount("limit", values.limit),
    offset: parseCount("offset", values.offset),
    port,
  });
  return {
    data: { total: result.total, results: result.hits },
    warnings: result.warnings.map(
      (warning) => `${warning.path}: ${warning.message}`,
    ),
    text: formatSearch(result.total, result.hits),
  };
}

async function runRead({ dir, port, positionals }: Context): Promise<Outcome> {
  await assertNotebook(dir);
  const loaded = await readEntry(dir, required(positionals[0], "an ID"));
  const url = entryUrl(loaded.entry.id, port);
  return {
    data: {
      ...loaded.entry,
      body: loaded.body,
      revision: loaded.revision,
      url,
    },
    warnings: [],
    text: formatEntry(loaded, url),
  };
}

async function runUpdate({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  const patch = await readJsonInput(required(values.input, "--input"));
  return mutation(
    await updateEntry(
      dir,
      requireId(positionals),
      requireRevision(values),
      patch,
      { port },
    ),
    "Updated",
  );
}

async function runReady({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  return mutation(
    await markReady(dir, requireId(positionals), requireRevision(values), {
      port,
    }),
    "Marked ready",
  );
}

async function runArchive({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  return mutation(
    await archiveEntry(dir, requireId(positionals), requireRevision(values), {
      port,
    }),
    "Archived",
  );
}

async function runRestore({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  return mutation(
    await restoreEntry(dir, requireId(positionals), requireRevision(values), {
      port,
    }),
    "Restored",
  );
}

async function runAttach({
  dir,
  port,
  positionals,
  values,
}: Context): Promise<Outcome> {
  return mutation(
    await addAttachment(
      dir,
      requireId(positionals),
      requireRevision(values),
      required(values.file, "--file"),
      { port, name: values.name },
    ),
    "Attached a file to",
  );
}

async function runStatus({ dir }: Context): Promise<Outcome> {
  const status: StatusData = (await isNotebook(dir))
    ? {
        dir,
        repo_ok: true,
        head_commit: (await headCommit(dir)) ?? null,
        remote_configured: await hasRemote(dir),
        unpublished_commits: (await unpublishedCommits(dir)).length,
        last_backup: await readBackupState(dir),
      }
    : {
        dir,
        repo_ok: false,
        head_commit: null,
        remote_configured: false,
        unpublished_commits: 0,
        last_backup: null,
      };
  return { data: status, warnings: [], text: formatStatus(status) };
}

async function runBackup({ dir }: Context): Promise<Outcome> {
  const backup = await retryBackup(dir);
  return { data: {}, backup, warnings: [], text: formatBackup(backup) };
}

function mutation(result: MutationResult, verb: string): Outcome {
  return {
    data: {
      id: result.id,
      title: result.title,
      status: result.status,
      url: result.url,
      revision: result.revision,
      commit: result.commit,
    },
    backup: result.backup,
    warnings: result.warnings,
    text: formatMutation(verb, result),
  };
}

export async function readJsonInput(source: string): Promise<unknown> {
  const bytes =
    source === "-" ? await readStdin() : await readFileInput(source);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new NotebookError("VALIDATION_FAILED", "input is not valid JSON");
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > INPUT_LIMIT_BYTES) throw inputTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readFileInput(path: string): Promise<Buffer> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new NotebookError("NOT_FOUND", "input file not found");
    }
    throw error;
  }
  if (!info.isFile()) {
    throw usage("--input must be a regular file or -");
  }
  if (info.size > INPUT_LIMIT_BYTES) throw inputTooLarge();
  const bytes = await readFile(path);
  if (bytes.byteLength > INPUT_LIMIT_BYTES) throw inputTooLarge();
  return bytes;
}

function inputTooLarge(): NotebookError {
  return new NotebookError("VALIDATION_FAILED", "input exceeds 4 MiB");
}

function assertCreatable(parsed: ParsedEntry): void {
  unwrap(serializeEntry(parsed));
  assertNoSecrets(scanEntry(parsed.entry, parsed.body));
}

function unwrap<T>(result: Validation<T>): T {
  if (result.ok) return result.value;
  throw new NotebookError("VALIDATION_FAILED", describeErrors(result.errors), {
    errors: result.errors,
  });
}

function assertNoSecrets(findings: SecretFinding[]): void {
  if (findings.length === 0) return;
  throw new NotebookError(
    "SECRET_DETECTED",
    "possible secret found; nothing was written",
    { findings },
  );
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") {
    throw usage(`${what} is required`);
  }
  return value;
}

function requireId(positionals: string[]): string {
  return required(positionals[0], "an ID");
}

function requireRevision(values: Values): string {
  return required(values["expected-revision"], "--expected-revision");
}

function parseCount(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw usage(`--${flag} must be a whole number`);
  return Number(raw);
}

function parseStatus(raw: string | undefined): Status | undefined {
  if (raw === undefined) return undefined;
  if (!(STATUSES as readonly string[]).includes(raw)) {
    throw usage("--status must be draft, ready, or archived");
  }
  return raw as Status;
}
