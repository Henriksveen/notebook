import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { NotebookError } from "../src/errors.ts";
import { createItem } from "../src/library.ts";
import { assertNotebook, initNotebook } from "../src/notebook.ts";
import {
  cleanupTempDirs,
  commitCount,
  git,
  makeBareRemote,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

after(cleanupTempDirs);
async function rejectionOf(promise: Promise<unknown>): Promise<NotebookError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NotebookError) return error;
    throw error;
  }
  throw new Error("expected failure");
}
describe("init", () => {
  it("creates a notebook with README, .gitignore, and an initial commit", async () => {
    const dir = join(await makeTempDir(), "nb");
    const result = await initNotebook(dir);
    assert.equal(result.created, true);
    assert.equal(
      await readFile(join(dir, ".gitignore"), "utf8"),
      ".notebook/\n",
    );
    assert.equal(await commitCount(dir), 1);
    assert.equal(
      await git(dir, ["log", "-1", "--format=%s"]),
      "notebook: init",
    );
    assert.equal(result.remote, false);
  });

  it("refuses a non-empty directory that is not a notebook", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, "stuff.txt"), "x");
    const error = await rejectionOf(initNotebook(dir));
    assert.equal(error.code, "NOT_A_NOTEBOOK");
  });

  it("refuses an ordinary git repository with a README.md and commits nothing", async () => {
    const dir = await makeTempDir();
    await git(dir, ["init", "-q", "-b", "main"]);
    await writeFile(join(dir, "README.md"), "# Mine\n");
    await git(dir, ["add", "--", "README.md"]);
    await git(dir, ["commit", "-q", "-m", "mine"]);
    const before = await commitCount(dir);
    const initError = await rejectionOf(initNotebook(dir));
    assert.equal(initError.code, "NOT_A_NOTEBOOK");
    const createError = await rejectionOf(
      createItem(
        dir,
        "page",
        { title: "x", summary: "y", kind: "concept" },
        "<p>x</p>",
      ),
    );
    assert.equal(createError.code, "NOT_A_NOTEBOOK");
    assert.equal(await commitCount(dir), before);
  });

  it("refuses a notebook whose format marker or .gitignore entry is missing", async () => {
    const withoutMarker = await newNotebook();
    await rm(join(withoutMarker, ".notebook-format"));
    const markerError = await rejectionOf(
      createItem(
        withoutMarker,
        "page",
        { title: "x", summary: "y", kind: "concept" },
        "<p>x</p>",
      ),
    );
    assert.equal(markerError.code, "NOT_A_NOTEBOOK");

    const withoutIgnore = await newNotebook();
    await writeFile(join(withoutIgnore, ".gitignore"), "");
    const ignoreError = await rejectionOf(
      createItem(
        withoutIgnore,
        "page",
        { title: "x", summary: "y", kind: "concept" },
        "<p>x</p>",
      ),
    );
    assert.equal(ignoreError.code, "NOT_A_NOTEBOOK");
  });

  it("is a no-op for an existing notebook and can add origin", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    const again = await initNotebook(dir, { remote: bare });
    assert.equal(again.created, false);
    assert.equal(again.remote, true);
    assert.equal(
      await git(dir, ["config", "--get", "remote.origin.url"]),
      bare,
    );
    assert.equal(await commitCount(dir), 1);
  });

  it("rejects remotes that look like options", async () => {
    const error = await rejectionOf(
      initNotebook(join(await makeTempDir(), "nb"), {
        remote: "--upload-pack=x",
      }),
    );
    assert.equal(error.code, "USAGE");
  });
});

it("refuses unsupported notebook formats without adopting or changing them", async () => {
  const dir = await newNotebook();
  await writeFile(join(dir, ".notebook-format"), "notebook-format 1\n");
  await git(dir, ["add", ".notebook-format"]);
  await git(dir, ["commit", "-m", "unsupported format"]);
  const head = await git(dir, ["rev-parse", "HEAD"]);
  await assert.rejects(assertNotebook(dir), { code: "NOT_A_NOTEBOOK" });
  await assert.rejects(initNotebook(dir), { code: "NOT_A_NOTEBOOK" });
  assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
});

it("refuses publication when the format marker has staged or unstaged changes", async () => {
  const dir = await newNotebook();
  const marker = join(dir, ".notebook-format"),
    head = await git(dir, ["rev-parse", "HEAD"]);
  await writeFile(marker, "notebook-format 1\n");
  await git(dir, ["add", ".notebook-format"]);
  await writeFile(marker, "notebook-format 2\n");
  await assert.rejects(
    createItem(
      dir,
      "page",
      { title: "x", summary: "y", kind: "concept" },
      "<p>x</p>",
    ),
    { code: "DIRTY_TARGET" },
  );
  assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
});
