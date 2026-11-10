import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { stringify } from "yaml";
import { readItem } from "../src/library-store.ts";
import { cleanupTempDirs, git, ID_1, newNotebook, STAMP } from "./fixtures.ts";

after(cleanupTempDirs);
const metadata = {
  schema_version: 2,
  entity: "page",
  id: ID_1,
  title: "Git",
  summary: "Visual guide",
  kind: "concept",
  project: "Inbox",
  topics: [],
  sources: [],
  archived: false,
  created_at: STAMP,
  updated_at: STAMP,
  change_summary: "Created page",
};
async function fixture() {
  const dir = await newNotebook();
  const base = join(dir, "pages", ID_1);
  await mkdir(base, { recursive: true });
  await writeFile(join(base, "page.yaml"), stringify(metadata));
  await writeFile(join(base, "index.html"), "<p>Original</p>");
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "page"]);
  return { dir, base };
}
it("reads pinned committed bytes and includes context absence in revision", async () => {
  const { dir, base } = await fixture();
  const original = await readItem(dir, "page", ID_1);
  // The fixture carries the legacy archive flag, which reads drop.
  assert.equal("archived" in original.item, false);
  await writeFile(join(base, "index.html"), "<p>Unpublished</p>");
  assert.equal((await readItem(dir, "page", ID_1)).html, "<p>Original</p>");
  await writeFile(join(base, "context.md"), "Learning goals");
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "context"]);
  const changed = await readItem(dir, "page", ID_1);
  assert.notEqual(changed.revision, original.revision);
  assert.equal(
    (await readItem(dir, "page", ID_1, original.commit)).context,
    undefined,
  );
  await assert.rejects(readItem(dir, "page", "../../etc"));
  await assert.rejects(readItem(dir, "page", ID_1, "HEAD~1"));
});
it("refuses committed symlinks and incomplete items", async () => {
  const { dir, base } = await fixture();
  await symlink("/etc/passwd", join(base, "context.md"));
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "bad"]);
  await assert.rejects(readItem(dir, "page", ID_1), /regular/);
});
