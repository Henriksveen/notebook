import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyUpdate,
  buildNewEntry,
  listEntries,
  readEntry,
} from "../src/store.ts";
import {
  ID_1,
  ID_2,
  ID_3,
  makeEntry,
  makeTempDir,
  STAMP,
  writeEntryFile,
} from "./fixtures.ts";

describe("listing", () => {
  it("returns an empty list when there are no entries", async () => {
    const dir = await makeTempDir();
    assert.deepEqual(await listEntries(dir), { entries: [], warnings: [] });
  });

  it("skips invalid files with warnings instead of failing", async () => {
    const dir = await makeTempDir();
    await writeEntryFile(dir, makeEntry({ id: ID_1 }));
    await writeFile(
      join(dir, "entries", `${ID_2}.md`),
      "---\nnot: [valid\n---\nbody\n",
    );
    await writeFile(join(dir, "entries", `${ID_3}.md`), "");
    await writeFile(join(dir, "entries", "notes.txt"), "stray");

    const { entries, warnings } = await listEntries(dir);
    assert.deepEqual(
      entries.map((loaded) => loaded.entry.id),
      [ID_1],
    );
    assert.deepEqual(
      warnings.map((warning) => warning.path),
      [
        join("entries", `${ID_2}.md`),
        join("entries", `${ID_3}.md`),
        join("entries", "notes.txt"),
      ],
    );
  });

  it("reports an entry whose id does not match its file name", async () => {
    const dir = await makeTempDir();
    const file = await writeEntryFile(dir, makeEntry({ id: ID_1 }));
    await rename(file, join(dir, "entries", `${ID_2}.md`));
    const { entries, warnings } = await listEntries(dir);
    assert.equal(entries.length, 0);
    assert.match(warnings[0].message, /does not match file name/);
  });

  it("skips symlinked entry files with a warning", async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir();
    const file = await writeEntryFile(outside, makeEntry({ id: ID_2 }));
    await mkdir(join(dir, "entries"));
    await symlink(file, join(dir, "entries", `${ID_2}.md`));
    const { entries, warnings } = await listEntries(dir);
    assert.equal(entries.length, 0);
    assert.equal(warnings.length, 1);
  });
});

describe("reading", () => {
  it("returns the entry, body and SHA-256 revision of the exact bytes", async () => {
    const dir = await makeTempDir();
    const file = await writeEntryFile(dir, makeEntry(), "Hello\n");
    const bytes = await readFile(file);
    const loaded = await readEntry(dir, ID_1);
    assert.equal(loaded.entry.title, "Sample entry");
    assert.equal(loaded.body, "Hello\n");
    assert.equal(
      loaded.revision,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(loaded.path, file);
  });

  it("reports NOT_FOUND, USAGE for bad ids, and rejects symlinks", async () => {
    const dir = await makeTempDir();
    await assert.rejects(readEntry(dir, ID_1), { code: "NOT_FOUND" });
    await assert.rejects(readEntry(dir, "../escape"), { code: "USAGE" });
    const outside = await makeTempDir();
    const file = await writeEntryFile(outside, makeEntry({ id: ID_2 }));
    await mkdir(join(dir, "entries"));
    await symlink(file, join(dir, "entries", `${ID_2}.md`));
    await assert.rejects(readEntry(dir, ID_2), { code: "UNSAFE_PATH" });
  });
});

describe("pure entry builders", () => {
  const input = {
    title: "New",
    summary: "Summary",
    type: "note",
    body: "Body",
    topics: ["B", "a"],
  };

  it("builds a draft with a fresh id and matching timestamps", () => {
    const now = new Date(STAMP);
    const result = buildNewEntry(input, { now });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const { entry, body } = result.value;
    assert.equal(entry.status, "draft");
    assert.equal(entry.project, "Inbox");
    assert.deepEqual(entry.topics, ["a", "b"]);
    assert.equal(entry.created_at, STAMP);
    assert.equal(entry.updated_at, STAMP);
    assert.deepEqual(entry.attachments, []);
    assert.equal(body, "Body");
    const other = buildNewEntry(input);
    assert.equal(other.ok && other.value.entry.id !== entry.id, true);
  });

  it("refuses create input that sets managed fields", () => {
    assert.equal(buildNewEntry({ ...input, status: "ready" }).ok, false);
    assert.equal(buildNewEntry({ ...input, id: ID_1 }).ok, false);
  });

  it("applies an update without touching immutable fields", () => {
    const current = { entry: makeEntry({ status: "ready" }), body: "Old body" };
    const later = new Date("2026-11-01T08:00:00.000Z");
    const result = applyUpdate(
      current,
      { title: "Changed", body: "New body" },
      later,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.entry.title, "Changed");
    assert.equal(result.value.entry.updated_at, "2026-11-01T08:00:00.000Z");
    assert.equal(result.value.entry.id, ID_1);
    assert.equal(result.value.entry.created_at, STAMP);
    assert.equal(result.value.entry.status, "ready");
    assert.equal(result.value.body, "New body");
    assert.equal(current.entry.title, "Sample entry");
  });

  it("rejects updates to status, id, created_at and attachments", () => {
    const current = { entry: makeEntry(), body: "Body" };
    for (const field of ["status", "id", "created_at", "attachments"]) {
      assert.equal(applyUpdate(current, { [field]: "x" }).ok, false, field);
    }
  });
});
