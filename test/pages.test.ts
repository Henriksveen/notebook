import assert from "node:assert/strict";
import { after, it } from "node:test";
import {
  createItem,
  history,
  readItem,
  restoreItem,
  updateItem,
} from "../src/library.ts";
import { cleanupTempDirs, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);
it("creates, deepens and restores a page at one stable identity", async () => {
  const dir = await newNotebook();
  const saved = await createItem(
    dir,
    "page",
    {
      title: "Git",
      summary: "Guide",
      kind: "concept",
      context: "Learn visually",
    },
    "<p>Original</p>",
  );
  const current = await readItem(dir, "page", saved.id);
  const updated = await updateItem(
    dir,
    "page",
    saved.id,
    current.revision,
    { title: "Git rebasing", change_summary: "Add worked example" },
    "<p>Original and example</p>",
  );
  assert.equal(updated.url, saved.url);
  assert.equal(
    (await readItem(dir, "page", saved.id)).context,
    "Learn visually",
  );
  await assert.rejects(
    updateItem(dir, "page", saved.id, current.revision, {
      change_summary: "stale",
    }),
  );
  const restored = await restoreItem(
    dir,
    "page",
    saved.id,
    updated.revision,
    saved.commit,
  );
  assert.equal((await readItem(dir, "page", saved.id)).html, "<p>Original</p>");
  assert.notEqual(restored.commit, saved.commit);
  assert.equal((await history(dir, "page", saved.id)).length, 3);
});

it("serializes competing updates and keeps read snapshots coherent", async () => {
  const dir = await newNotebook();
  const saved = await createItem(
    dir,
    "page",
    {
      title: "Version 0",
      summary: "Guide",
      kind: "concept",
      context: "Version 0",
    },
    "Version 0",
  );
  const changes = await Promise.allSettled([
    updateItem(
      dir,
      "page",
      saved.id,
      saved.revision,
      { title: "Version 1", context: "Version 1", change_summary: "First" },
      "Version 1",
    ),
    updateItem(
      dir,
      "page",
      saved.id,
      saved.revision,
      { title: "Version 2", context: "Version 2", change_summary: "Second" },
      "Version 2",
    ),
  ]);
  assert.equal(
    changes.filter((change) => change.status === "fulfilled").length,
    1,
  );
  const current = await readItem(dir, "page", saved.id);
  const publishing = updateItem(
    dir,
    "page",
    saved.id,
    current.revision,
    { title: "Version 3", context: "Version 3", change_summary: "Third" },
    "Version 3",
  );
  const reads = await Promise.all(
    Array.from({ length: 8 }, () => readItem(dir, "page", saved.id)),
  );
  await publishing;
  for (const loaded of reads) {
    assert.equal(loaded.item.title, loaded.html);
    assert.equal(loaded.context, loaded.html);
  }
});
it("refuses unsafe historical content on restore", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { git } = await import("./fixtures.ts");
  const dir = await newNotebook();
  const saved = await createItem(
    dir,
    "page",
    { title: "Safe", summary: "Guide", kind: "concept" },
    "Safe",
  );
  await writeFile(
    join(dir, `pages/${saved.id}/index.html`),
    `ghp_${"A".repeat(36)}`,
  );
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "unsafe manual version"]);
  const unsafe = await git(dir, ["rev-parse", "HEAD"]);
  const loaded = await readItem(dir, "page", saved.id);
  const clean = await updateItem(
    dir,
    "page",
    saved.id,
    loaded.revision,
    { change_summary: "Clean up" },
    "Safe again",
  );
  await assert.rejects(
    restoreItem(dir, "page", saved.id, clean.revision, unsafe),
    /secret/,
  );
  assert.equal((await readItem(dir, "page", saved.id)).html, "Safe again");
});

it("searches decoded HTML text while excluding scripts and supporting context", async () => {
  const { searchLibrary } = await import("../src/library-search.ts");
  const dir = await newNotebook();
  await createItem(
    dir,
    "page",
    {
      title: "Research",
      summary: "Visible content",
      kind: "concept",
      context: "privatecontext",
    },
    "<p>R&amp;D and &lt;examples&gt;</p><script>hiddenScriptSentinel</script><style>hiddenStyleSentinel</style>",
  );
  assert.equal((await searchLibrary(dir, "page", { query: "R&D" })).total, 1);
  for (const query of [
    "privatecontext",
    "hiddenScriptSentinel",
    "hiddenStyleSentinel",
  ])
    assert.equal((await searchLibrary(dir, "page", { query })).total, 0);
});
