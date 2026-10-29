import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeEntry } from "../src/frontmatter.ts";
import type { Entry } from "../src/schema.ts";

export const ID_1 = "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b";
export const ID_2 = "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e";
export const ID_3 = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const STAMP = "2026-10-29T12:00:00.000Z";

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

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "notebook-test-"));
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
