import type { CommandName, Values } from "./args.ts";
import { readBackupState } from "./backup.ts";
import { hasRemote, headCommit, unpublishedCommits } from "./git.ts";
import { runLibrary } from "./library-commands.ts";
import {
  assertNotebook,
  initNotebook,
  isNotebook,
  retryBackup,
} from "./notebook.ts";
import {
  formatBackup,
  formatInit,
  formatOpen,
  formatStatus,
  type Outcome,
  type StatusData,
  successJson,
} from "./output.ts";
import { openNotebook } from "./web/open.ts";
import { createServer } from "./web/server.ts";
export interface Context {
  dir: string;
  port: number;
  positionals: string[];
  values: Values;
}
type Handler = (context: Context) => Promise<Outcome>;
export const HANDLERS: Record<CommandName, Handler> = {
  page: (context) => runLibrary(context, "page"),
  prompt: (context) => runLibrary(context, "prompt"),
  init: runInit,
  status: runStatus,
  backup: runBackup,
  open: runOpen,
  serve: runServe,
};
async function runInit({ dir, values }: Context): Promise<Outcome> {
  const result = await initNotebook(dir, { remote: values.remote });
  return { data: result, warnings: [], text: formatInit(result) };
}

async function runStatus({ dir }: Context): Promise<Outcome> {
  const warnings: string[] = [];
  const status: StatusData = (await isNotebook(dir))
    ? {
        dir,
        repo_ok: true,
        head_commit: (await headCommit(dir)) ?? null,
        remote_configured: await hasRemote(dir),
        unpublished_commits: await countUnpublished(dir, warnings),
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
  return { data: status, warnings, text: formatStatus(status) };
}

async function countUnpublished(
  dir: string,
  warnings: string[],
): Promise<number | null> {
  try {
    return (await unpublishedCommits(dir)).length;
  } catch {
    warnings.push("could not count unpublished commits");
    return null;
  }
}

async function runBackup({ dir }: Context): Promise<Outcome> {
  const { backup, warnings } = await retryBackup(dir);
  return { data: {}, backup, warnings, text: formatBackup(backup) };
}

async function runOpen({ dir, port, values }: Context): Promise<Outcome> {
  await assertNotebook(dir);
  const opened = await openNotebook({
    dir,
    port,
    noBrowser: values["no-browser"] === true,
  });
  return {
    data: { url: opened.url, reused: opened.reused },
    warnings: opened.warnings,
    text: formatOpen(opened.url, opened.reused),
  };
}
async function runServe({ dir, port, values }: Context): Promise<Outcome> {
  await assertNotebook(dir);
  const server = await createServer({ dir, port });
  const data = { url: server.url, reused: false };
  process.stdout.write(
    values.json
      ? successJson({ data, warnings: [], text: "" })
      : `Serving the notebook at ${server.url} (Ctrl+C to stop)\n`,
  );
  await waitForStop();
  await server.close();
  return { data, warnings: [], text: "", silent: true };
}

function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
