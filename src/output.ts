import type { BackupResult, BackupState } from "./backup.ts";
import { NotebookError } from "./errors.ts";
import type { InitResult } from "./notebook.ts";
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
  page <create|read|update|search|history|version|restore|open>
  prompt <create|read|update|search|render|history|version|restore|open>
  init [--remote URL]                 Initialize the notebook
  status                              Show repository and backup status
  backup                              Retry publishing local commits
  open [--no-browser]                Open the Pages library
  serve                               Run the local website until Ctrl+C

Item operations:
  create --input FILE|- [--html FILE (required for pages)]
  read ID
  update ID --expected-revision HASH --input FILE|- [--html FILE]
  search [QUERY...] [--project X] [--topic X] [--kind concept|report (pages)]
         [--limit N] [--offset N]
  history ID
  version ID --commit HASH
  restore ID --commit HASH --expected-revision HASH
  open ID [--no-browser]
  render ID --values FILE|-           Prompts only

Global options:
  --dir PATH   Default: $NOTEBOOK_DIR or ~/notebook
  --port N     Default: $NOTEBOOK_PORT or 43127
  --json       Print one JSON object on stdout
  --help, -h   Show this help
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

export function backupLabel(backup: BackupResult): string {
  return backup.reason ? `${backup.status} (${backup.reason})` : backup.status;
}

export function formatInit(result: InitResult): string {
  const heading = result.created
    ? `Created notebook at ${result.dir}`
    : `Notebook already exists at ${result.dir}`;
  return `${heading}\nRemote: ${result.remote ? "configured" : "not configured"}`;
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
