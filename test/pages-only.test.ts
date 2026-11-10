import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { promisify } from "node:util";
import { createItem, readItem, updateItem } from "../src/library.ts";
import { createServer } from "../src/web/server.ts";
import { cleanupTempDirs, git, makeTempDir, newNotebook } from "./fixtures.ts";

const run = promisify(execFile);
after(cleanupTempDirs);
it("offers only pages, prompts and notebook administration", async () => {
  const dir = await makeTempDir();
  const help = (await run("node", ["src/cli.ts", "--help"])).stdout;
  assert.doesNotMatch(help, /legacy|attachment|upgrade|import>/i);
  for (const command of [
    "create",
    "read",
    "search",
    "update",
    "validate",
    "ready",
    "attach",
    "archive",
    "restore",
    "upgrade",
  ]) {
    await assert.rejects(
      run("node", ["src/cli.ts", "--dir", dir, command, "--json"]),
      (error: unknown) =>
        JSON.parse((error as { stdout: string }).stdout).error.code === "USAGE",
    );
  }
  await assert.rejects(
    run("node", ["src/cli.ts", "--dir", dir, "page", "import", "--json"]),
    (error: unknown) =>
      JSON.parse((error as { stdout: string }).stdout).error.code === "USAGE",
  );
});
it("has no obsolete navigation or content routes", async () => {
  const dir = await newNotebook(),
    server = await createServer({ dir, port: 0 });
  try {
    const home = await (await fetch(server.url)).text();
    assert.match(home, /Pages/);
    assert.match(home, /Prompts/);
    assert.doesNotMatch(home, /legacy|\/projects|\/topics|\/search/);
    for (const path of [
      "legacy",
      "search",
      "projects",
      "topics",
      "entries/anything",
      "attachments/anything/anything/view",
    ]) {
      assert.equal((await fetch(new URL(path, server.url))).status, 404, path);
    }
  } finally {
    await server.close();
  }
});
it("preserves stored page provenance without an importer", async () => {
  const dir = await newNotebook();
  const page = await createItem(
    dir,
    "page",
    { title: "Previously migrated", summary: "A working page", kind: "report" },
    "<p>Keep working</p>",
  );
  const path = join(dir, `pages/${page.id}/page.yaml`);
  const { readFile } = await import("node:fs/promises");
  const { parse, stringify } = await import("yaml");
  const metadata = parse(await readFile(path, "utf8"));
  metadata.imported_from = {
    entry: "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b",
    attachment: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    sha256: "a".repeat(64),
  };
  await writeFile(path, stringify(metadata));
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "provenance fixture"]);
  const loaded = await readItem(dir, "page", page.id);
  await updateItem(dir, "page", page.id, loaded.revision, {
    change_summary: "Deepen",
    summary: "Still works",
  });
  assert.deepEqual((await readItem(dir, "page", page.id)).item.entity, "page");
  const final = (await readItem(dir, "page", page.id)).item;
  assert.equal(final.entity, "page");
  if (final.entity === "page")
    assert.deepEqual(final.imported_from, metadata.imported_from);
});
