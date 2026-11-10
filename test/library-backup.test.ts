import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { attemptBackup } from "../src/backup.ts";
import {
  cleanupTempDirs,
  git,
  ID_1,
  makeBareRemote,
  newNotebook,
} from "./fixtures.ts";

after(cleanupTempDirs);
const secret = `ghp_${"A".repeat(36)}`;
it("scans every new text path, including secrets removed in a later commit", async () => {
  for (const path of [
    `pages/${ID_1}/index.html`,
    `pages/${ID_1}/page.yaml`,
    `pages/${ID_1}/context.md`,
    `prompts/${ID_1}.md`,
  ]) {
    const dir = await newNotebook(),
      remote = await makeBareRemote();
    await git(dir, ["remote", "add", "origin", remote]);
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), secret);
    await git(dir, ["add", "--", path]);
    await git(dir, ["commit", "-m", "unsafe version"]);
    await writeFile(join(dir, path), "safe now");
    await git(dir, ["add", "--", path]);
    await git(dir, ["commit", "-m", "later safe version"]);
    assert.equal(
      (await attemptBackup(dir)).reason,
      "secret_in_unpublished_commit",
    );
    await assert.rejects(git(remote, ["rev-parse", "--verify", "main"]));
  }
});
it("scans a page secret introduced only by a merge resolution", async () => {
  const dir = await newNotebook(),
    remote = await makeBareRemote();
  await git(dir, ["remote", "add", "origin", remote]);
  await attemptBackup(dir);
  const path = `pages/${ID_1}/page.yaml`;
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await git(dir, ["checkout", "-b", "side"]);
  await writeFile(join(dir, path), "side");
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "side"]);
  await git(dir, ["checkout", "main"]);
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), "main");
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "-m", "main"]);
  await assert.rejects(git(dir, ["merge", "--no-edit", "side"]));
  await writeFile(join(dir, path), secret);
  await git(dir, ["add", "pages"]);
  await git(dir, ["commit", "--no-edit"]);
  assert.equal(
    (await attemptBackup(dir)).reason,
    "secret_in_unpublished_commit",
  );
});
