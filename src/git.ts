import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NotebookError } from "./errors.ts";

const MAX_BUFFER = 64 * 1024 * 1024;
const IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

export type PushFailure = "push_failed" | "timeout";
export type PushOutcome = { ok: true } | { ok: false; reason: PushFailure };

interface GitRun {
  ok: boolean;
  stdout: Buffer;
  timedOut: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function run(dir: string, args: string[], timeoutMs = 0): Promise<GitRun> {
  return new Promise((done) => {
    execFile(
      "git",
      ["-c", "core.askPass=", ...args],
      {
        cwd: dir,
        env: gitEnv(),
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
      },
      (error, stdout) =>
        done({ ok: error === null, stdout, timedOut: error?.killed === true }),
    );
  });
}

async function text(dir: string, args: string[]): Promise<string | undefined> {
  const result = await run(dir, args);
  return result.ok ? result.stdout.toString("utf8").trim() : undefined;
}

async function mustRun(dir: string, args: string[]): Promise<void> {
  const result = await run(dir, args);
  if (!result.ok) throw new Error(`git ${args[0]} failed`);
}

function splitNul(stdout: Buffer): string[] {
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((item) => item !== "");
}

export async function initRepository(dir: string): Promise<void> {
  await mustRun(dir, ["init", "-b", "main"]);
}

export async function repoTopLevel(dir: string): Promise<string | undefined> {
  return text(dir, ["rev-parse", "--show-toplevel"]);
}

export async function repoState(dir: string): Promise<string> {
  const gitDir = await text(dir, ["rev-parse", "--git-dir"]);
  if (gitDir === undefined) {
    throw new NotebookError(
      "REPO_STATE",
      "the notebook is not a git repository",
    );
  }
  const base = resolve(dir, gitDir);
  if (IN_PROGRESS_MARKERS.some((name) => existsSync(join(base, name)))) {
    throw new NotebookError(
      "REPO_STATE",
      "a merge, rebase, or cherry-pick is in progress; finish or abort it first",
    );
  }
  const branch = await currentBranch(dir);
  if (!branch) {
    throw new NotebookError(
      "REPO_STATE",
      "HEAD is detached or has no branch; check out a branch first",
    );
  }
  return branch;
}

export async function dirtyPaths(
  dir: string,
  pathspecs: string[],
): Promise<string[]> {
  const result = await run(dir, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ...pathspecs,
  ]);
  if (!result.ok) {
    throw new NotebookError("REPO_STATE", "could not read git status");
  }
  return splitNul(result.stdout).map((line) => line.slice(3));
}

export async function commitPaths(
  dir: string,
  paths: string[],
  message: string,
): Promise<void> {
  await ensureIdentity(dir);
  await mustRun(dir, ["add", "--", ...paths]);
  await mustRun(dir, [
    "commit",
    "--only",
    "--no-verify",
    "-m",
    message,
    "--",
    ...paths,
  ]);
}

async function ensureIdentity(dir: string): Promise<void> {
  if ((await text(dir, ["config", "--get", "user.email"])) !== undefined) {
    return;
  }
  await mustRun(dir, ["config", "user.name", "notebook"]);
  await mustRun(dir, ["config", "user.email", "notebook@localhost"]);
}

export async function headCommit(dir: string): Promise<string | undefined> {
  return text(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
}

export async function hasRemote(dir: string): Promise<boolean> {
  return (await run(dir, ["config", "--get", "remote.origin.url"])).ok;
}

export async function addOrigin(dir: string, url: string): Promise<void> {
  await mustRun(dir, ["remote", "add", "origin", url]);
}

async function upstreamRef(dir: string): Promise<string | undefined> {
  return text(dir, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{upstream}",
  ]);
}

export async function unpublishedCommits(dir: string): Promise<string[]> {
  const base = await publishedBase(dir);
  const range = base ? `${base}..HEAD` : "HEAD";
  const result = await run(dir, ["rev-list", range]);
  if (!result.ok) throw new Error("git rev-list failed");
  return result.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
}

export async function currentBranch(dir: string): Promise<string | undefined> {
  const ref = await text(dir, ["symbolic-ref", "-q", "HEAD"]);
  return ref?.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : undefined;
}

async function publishedBase(dir: string): Promise<string | undefined> {
  const branch = await currentBranch(dir);
  if (!branch) return undefined;
  return text(dir, [
    "rev-parse",
    "--verify",
    "-q",
    `refs/remotes/origin/${branch}`,
  ]);
}

export async function changedNotebookFiles(
  dir: string,
  commit: string,
): Promise<string[]> {
  const parents = await text(dir, ["show", "-s", "--format=%P", commit]);
  if (parents === undefined) throw new Error("git show failed");
  const isMerge = parents.split(" ").filter((hash) => hash !== "").length > 1;
  const result = isMerge
    ? await run(dir, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        commit,
        "--",
        "entries",
        "attachments",
      ])
    : await run(dir, [
        "diff-tree",
        "--root",
        "--no-commit-id",
        "-r",
        "--name-only",
        "--no-renames",
        "--diff-filter=AMT",
        "-z",
        commit,
        "--",
        "entries",
        "attachments",
      ]);
  if (!result.ok) throw new Error("git could not list notebook files");
  return splitNul(result.stdout);
}

export async function readBlob(
  dir: string,
  commit: string,
  path: string,
): Promise<Buffer> {
  const result = await run(dir, ["cat-file", "blob", `${commit}:${path}`]);
  if (!result.ok) throw new Error("git cat-file failed");
  return result.stdout;
}

export async function push(
  dir: string,
  timeoutMs: number,
): Promise<PushOutcome> {
  const branch = await currentBranch(dir);
  if (!branch || (await isMirror(dir))) {
    return { ok: false, reason: "push_failed" };
  }
  const args = [
    "-c",
    "push.followTags=false",
    "push",
    "--no-follow-tags",
    "--no-force-with-lease",
  ];
  if ((await upstreamRef(dir)) === undefined) args.push("--set-upstream");
  args.push("origin", `HEAD:refs/heads/${branch}`);
  const result = await runPush(dir, args, timeoutMs);
  if (result === "ok") return { ok: true };
  return {
    ok: false,
    reason: result === "timeout" ? "timeout" : "push_failed",
  };
}

async function isMirror(dir: string): Promise<boolean> {
  const value = await text(dir, [
    "config",
    "--get",
    "--type=bool",
    "remote.origin.mirror",
  ]);
  return value === "true";
}

function runPush(
  dir: string,
  args: string[],
  timeoutMs: number,
): Promise<"ok" | "failed" | "timeout"> {
  const env = gitEnv();
  env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes";
  return new Promise((done) => {
    const child = spawn("git", ["-c", "core.askPass=", ...args], {
      cwd: dir,
      env,
      stdio: "ignore",
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      done("failed");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) done("timeout");
      else done(code === 0 ? "ok" : "failed");
    });
  });
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group has already exited.
  }
}
