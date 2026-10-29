import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serializeEntry } from "../src/frontmatter.ts";
import { initNotebook } from "../src/notebook.ts";
import type { Entry } from "../src/schema.ts";

process.env.GIT_AUTHOR_NAME ??= "Notebook Test";
process.env.GIT_AUTHOR_EMAIL ??= "test@example.invalid";
process.env.GIT_COMMITTER_NAME ??= "Notebook Test";
process.env.GIT_COMMITTER_EMAIL ??= "test@example.invalid";

const execFileAsync = promisify(execFile);

export const ID_1 = "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b";
export const ID_2 = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
export const ID_3 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const STAMP = "2026-10-29T12:00:00.000Z";

export async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

export async function commitCount(dir: string): Promise<number> {
  return Number(await git(dir, ["rev-list", "--count", "HEAD"]));
}

export async function newNotebook(): Promise<string> {
  const dir = join(await makeTempDir(), "notebook");
  await initNotebook(dir);
  return dir;
}

export async function makeBareRemote(): Promise<string> {
  const root = await makeTempDir();
  const bare = join(root, "remote.git");
  await git(root, ["init", "--bare", "-b", "main", bare]);
  return bare;
}

export function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    schema_version: 1,
    id: ID_1,
    title: "Sample entry",
    summary: "A short summary.",
    project: "Inbox",
    topics: ["architecture"],
    type: "research",
    created_at: STAMP,
    updated_at: STAMP,
    status: "draft",
    sources: [],
    attachments: [],
    ...overrides,
  };
}

const tempDirs: string[] = [];

export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "notebook-test-"));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export async function writeEntryFile(
  dir: string,
  entry: Entry,
  body = "Body text.\n",
): Promise<string> {
  const result = serializeEntry({ entry, body });
  if (!result.ok)
    throw new Error(`fixture invalid: ${JSON.stringify(result.errors)}`);
  await mkdir(join(dir, "entries"), { recursive: true });
  const file = join(dir, "entries", `${entry.id}.md`);
  await writeFile(file, result.value);
  return file;
}
