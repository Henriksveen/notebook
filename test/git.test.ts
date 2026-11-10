import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  commitPaths,
  dirtyPaths,
  hasRemote,
  headCommit,
  repoState,
  unpublishedCommits,
} from "../src/git.ts";
import { cleanupTempDirs, git, makeTempDir, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);

describe("repoState", () => {
  it("returns the branch for a healthy notebook", async () => {
    const dir = await newNotebook();
    assert.equal(await repoState(dir), "main");
  });

  it("rejects detached HEAD with REPO_STATE", async () => {
    const dir = await newNotebook();
    await git(dir, ["checkout", "--detach"]);
    await assert.rejects(repoState(dir), { code: "REPO_STATE" });
  });

  it("rejects an in-progress merge with REPO_STATE", async () => {
    const dir = await newNotebook();
    await writeFile(join(dir, ".git", "MERGE_HEAD"), `${"a".repeat(40)}\n`);
    await assert.rejects(repoState(dir), { code: "REPO_STATE" });
  });

  it("rejects a directory that is not a repository", async () => {
    await assert.rejects(repoState(await makeTempDir()), {
      code: "REPO_STATE",
    });
  });
});

describe("dirtyPaths", () => {
  it("reports untracked, modified, and staged files under the given paths", async () => {
    const dir = await newNotebook();
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "new.md"), "x");
    await writeFile(join(dir, "README.md"), "changed\n");
    await writeFile(join(dir, "other.txt"), "staged\n");
    await git(dir, ["add", "other.txt"]);
    assert.deepEqual(await dirtyPaths(dir, ["notes"]), ["notes/new.md"]);
    assert.deepEqual(await dirtyPaths(dir, ["README.md", "other.txt"]), [
      "README.md",
      "other.txt",
    ]);
  });

  it("treats pathspecs literally, so globs do not match", async () => {
    const dir = await newNotebook();
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "abc.md"), "x");
    assert.deepEqual(await dirtyPaths(dir, ["notes/a*"]), []);
  });
});

describe("commitPaths", () => {
  it("commits only the named paths and keeps unrelated staged and unstaged work", async () => {
    const dir = await newNotebook();
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await git(dir, ["add", "staged.txt"]);
    await writeFile(join(dir, "README.md"), "edited\n");
    await writeFile(join(dir, "wanted.md"), "wanted\n");
    await commitPaths(dir, ["wanted.md"], "notebook: test wanted");
    assert.equal(
      await git(dir, ["show", "--format=", "--name-only", "HEAD"]),
      "wanted.md",
    );
    const status = await git(dir, ["status", "--porcelain=v1"]);
    assert.match(status, /^A {2}staged\.txt$/m);
    assert.match(status, /^\s*M README\.md$/m);
  });
});

describe("unpublishedCommits", () => {
  it("lists every commit when there is no upstream", async () => {
    const dir = await newNotebook();
    assert.equal((await unpublishedCommits(dir)).length, 1);
    assert.equal(await hasRemote(dir), false);
    assert.equal(typeof (await headCommit(dir)), "string");
  });
});
