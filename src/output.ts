import type { BackupResult, BackupState } from "./backup.ts";
import { NotebookError } from "./errors.ts";
import type { InitResult, MutationResult } from "./notebook.ts";
import type { Entry } from "./schema.ts";
import type { SearchHit } from "./search.ts";
import type { LoadedEntry } from "./store.ts";

export const API_VERSION = 1;

export interface Outcome {
  data: unknown;
  backup?: BackupResult;
  warnings: string[];
  text: string;
  silent?: boolean;
}

export interface Failure {
  code: string;
  message: string;
  details?: unknown;
  exitCode: number;
}

export interface StatusData {
  dir: string;
  repo_ok: boolean;
  head_commit: string | null;
  remote_configured: boolean;
  unpublished_commits: number | null;
  last_backup: BackupState | null;
}

export const USAGE_TEXT = `Usage: notebook [--dir PATH] [--json] [--port N] <command> [options]

Commands:
  init [--remote URL]                     Create the notebook, or add a remote to it
  create --input FILE|-                   Save a new draft entry from JSON
  validate (--input FILE|- | ID)          Check an entry without changing anything
  search [QUERY...] [--project X] [--topic X] [--type X] [--status X]
         [--include-archived] [--limit N] [--offset N]
  read ID                                 Show an entry with its body and revision
  update ID --expected-revision HASH --input FILE|-
  ready ID --expected-revision HASH       Mark a draft as ready
  archive ID --expected-revision HASH     Archive a draft or ready entry
  restore ID --expected-revision HASH     Restore an archived entry
  attach ID --expected-revision HASH --file PATH [--name NAME]
  status                                  Show repository and backup status
  backup                                  Retry pushing unpublished commits
  open [ID] [--no-browser]                Start or reuse the local website and open it
  serve                                   Run the local website in the foreground

Global options:
  --dir PATH    Notebook directory (default: $NOTEBOOK_DIR or ~/notebook)
  --json        Print one JSON object on stdout
  --port N      Website port for URLs (default: $NOTEBOOK_PORT or 43127)
  --help, -h    Show this help
`;

export function successJson(outcome: Outcome): string {
  const envelope = {
    api_version: API_VERSION,
    ok: true,
    data: outcome.data,
    ...(outcome.backup ? { backup: outcome.backup } : {}),
    warnings: outcome.warnings,
  };
  return `${JSON.stringify(envelope)}\n`;
}

export function failureJson(failure: Failure): string {
  const envelope = {
    api_version: API_VERSION,
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details !== undefined ? { details: failure.details } : {}),
    },
  };
  return `${JSON.stringify(envelope)}\n`;
}

export function toFailure(error: unknown): Failure {
  if (error instanceof NotebookError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      exitCode: error.code === "USAGE" ? 2 : 1,
    };
  }
  return {
    code: "INTERNAL",
    message: "unexpected internal error; set NOTEBOOK_DEBUG=1 for details",
    exitCode: 1,
  };
}

export function failureText(failure: Failure): string {
  const lines = [`error: ${failure.message} (${failure.code})`];
  const details = failure.details;
  if (typeof details === "object" && details !== null) {
    if (
      "current_revision" in details &&
      typeof details.current_revision === "string"
    ) {
      lines.push(`Current revision: ${details.current_revision}`);
    }
    if ("paths" in details && Array.isArray(details.paths)) {
      lines.push("Affected paths:");
      for (const path of details.paths) lines.push(`  ${String(path)}`);
    }
    if ("recovery" in details && typeof details.recovery === "string") {
      lines.push(`Recovery: ${details.recovery}`);
    }
  }
  if (failure.exitCode === 2) lines.push("Run notebook --help for usage.");
  return `${lines.join("\n")}\n`;
}

export function backupSummary(backup: BackupResult): string {
  if (backup.status === "pushed") return "Backup: pushed";
  return `Saved locally; backup ${backupLabel(backup)}`;
}

export function backupLabel(backup: BackupResult): string {
  return backup.reason ? `${backup.status} (${backup.reason})` : backup.status;
}

export function formatInit(result: InitResult): string {
  const heading = result.created
    ? `Created notebook at ${result.dir}`
    : `Notebook already exists at ${result.dir}`;
  return `${heading}\nRemote: ${result.remote ? "configured" : "not configured"}`;
}

export function formatMutation(verb: string, result: MutationResult): string {
  return [
    `${verb} "${result.title}" (${result.status})`,
    `ID: ${result.id}`,
    `URL: ${result.url}`,
    `Revision: ${result.revision}`,
    backupSummary(result.backup),
  ].join("\n");
}

export function formatEntry(loaded: LoadedEntry, url: string): string {
  const { entry } = loaded;
  const lines = [
    entry.title,
    `ID: ${entry.id}`,
    `Status: ${statusLabel(entry)}`,
    `Project: ${entry.project}`,
    `Type: ${entry.type}`,
  ];
  if (entry.topics.length > 0) lines.push(`Topics: ${entry.topics.join(", ")}`);
  lines.push(
    `Summary: ${entry.summary}`,
    `URL: ${url}`,
    `Revision: ${loaded.revision}`,
  );
  for (const attachment of entry.attachments) {
    lines.push(
      `Attachment: ${attachment.filename} (${attachment.media_type}, ${attachment.size} bytes, id ${attachment.id})`,
    );
  }
  return `${lines.join("\n")}\n\n${loaded.body}`;
}

function statusLabel(entry: Entry): string {
  return entry.archived_from
    ? `${entry.status} (from ${entry.archived_from})`
    : entry.status;
}

export function formatSearch(total: number, hits: SearchHit[]): string {
  if (hits.length === 0) return "No matching entries.";
  const lines = [`${total} match(es), showing ${hits.length}:`];
  for (const hit of hits) {
    lines.push(`${hit.id}  [${hit.status}] ${hit.title} (${hit.project})`);
  }
  return lines.join("\n");
}

export function formatStatus(data: StatusData): string {
  const lines = [
    `Notebook: ${data.dir}`,
    `Repository: ${data.repo_ok ? "ok" : "not a notebook"}`,
    `Head: ${data.head_commit ?? "none"}`,
    `Remote: ${data.remote_configured ? "configured" : "not configured"}`,
    `Unpublished commits: ${data.unpublished_commits ?? "unknown"}`,
  ];
  const last = data.last_backup;
  if (last === null) {
    lines.push("Last backup: none recorded");
  } else {
    const reason = last.reason ? ` (${last.reason})` : "";
    lines.push(`Last backup: ${last.status}${reason} at ${last.attempted_at}`);
  }
  return lines.join("\n");
}

export function formatBackup(backup: BackupResult): string {
  return `Backup: ${backupLabel(backup)}`;
}

export function formatOpen(url: string, reused: boolean): string {
  return reused
    ? `Notebook website already running: ${url}`
    : `Started the notebook website: ${url}`;
}
