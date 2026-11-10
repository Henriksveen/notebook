import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { attemptBackup, readBackupState } from "../src/backup.ts";
import { createItem } from "../src/library.ts";
import { initNotebook } from "../src/notebook.ts";
import {
  cleanupTempDirs,
  git,
  ID_1,
  makeBareRemote,
  makeFailingRevListGit,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

const SECRET_TOKEN = `ghp_${"A".repeat(36)}`;

function input() {
  return {
    title: "Backup check",
    summary: "Summary.",
    kind: "concept",
  };
}

after(cleanupTempDirs);

describe("attemptBackup", () => {
  it("reports pending/no_remote when origin is not configured", async () => {
    const dir = await newNotebook();
    assert.deepEqual(await attemptBackup(dir), {
      status: "pending",
      reason: "no_remote",
    });
  });

  it("pushes new commits to a local bare remote", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, { status: "pushed" });
    assert.equal(
      await git(bare, ["rev-parse", "main"]),
      await git(dir, ["rev-parse", "HEAD"]),
    );
  });

  it("reports pending/push_failed for an unreachable remote, then pushes after the remote is fixed", async () => {
    const dir = await newNotebook();
    const missing = join(await makeTempDir(), "missing.git");
    await initNotebook(dir, { remote: missing });
    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, {
      status: "pending",
      reason: "push_failed",
    });

    const bare = await makeBareRemote();
    await git(dir, ["remote", "set-url", "origin", bare]);
    assert.deepEqual(await attemptBackup(dir), { status: "pushed" });
    assert.equal(
      await git(bare, ["rev-parse", "main"]),
      await git(dir, ["rev-parse", "HEAD"]),
    );
  });

  it("reports pending/timeout when the push exceeds the timeout", async () => {
    const dir = await newNotebook();
    await initNotebook(dir, { remote: await makeBareRemote() });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(await attemptBackup(dir, { pushTimeoutMs: 1 }), {
      status: "pending",
      reason: "timeout",
    });
  });

  it("returns promptly on timeout even when the transport spawns long-lived children", async () => {
    const dir = await newNotebook();
    const fakeSsh = join(await makeTempDir(), "fake-ssh");
    await writeFile(fakeSsh, "#!/bin/sh\nsleep 30 &\nsleep 30\n", {
      mode: 0o755,
    });
    await initNotebook(dir, { remote: "ssh://notebook.invalid/repo.git" });
    const previous = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = fakeSsh;
    try {
      const started = Date.now();
      assert.deepEqual(await attemptBackup(dir, { pushTimeoutMs: 500 }), {
        status: "pending",
        reason: "timeout",
      });
      assert.ok(Date.now() - started < 5000);
    } finally {
      if (previous === undefined) delete process.env.GIT_SSH_COMMAND;
      else process.env.GIT_SSH_COMMAND = previous;
    }
  });

  it("blocks a manually committed secret in notes/ and does not push it", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await mkdir(join(dir, "notes"));
    await writeFile(
      join(dir, "notes", `${ID_1}.md`),
      `---\ntitle: "Manual"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "notes"]);
    await git(dir, ["commit", "-m", "manual commit"]);

    assert.deepEqual(await attemptBackup(dir), {
      status: "blocked",
      reason: "secret_in_unpublished_commit",
    });
    await assert.rejects(git(bare, ["rev-parse", "--verify", "-q", "main"]));
  });

  it("persists the last result with a timestamp and no remote URL", async () => {
    const dir = await newNotebook();
    const missing = join(await makeTempDir(), "private-location.git");
    await initNotebook(dir, { remote: missing });
    await createItem(dir, "page", input(), "<p>Body.</p>");

    const state = await readBackupState(dir);
    assert.equal(state?.status, "pending");
    assert.equal(state?.reason, "push_failed");
    assert.match(state?.attempted_at ?? "", /^\d{4}-\d{2}-\d{2}T/);
    const raw = await readFile(
      join(dir, ".notebook", "backup-state.json"),
      "utf8",
    );
    assert.equal(raw.includes("private-location"), false);
  });

  it("returns null from readBackupState before any backup attempt", async () => {
    assert.equal(await readBackupState(await newNotebook()), null);
  });

  it("never force-pushes over a divergent remote, even when remote.origin.push asks for it", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    const other = join(await makeTempDir(), "other");
    await git(dirname(other), ["clone", "-q", bare, other]);
    await git(other, ["commit", "-q", "--allow-empty", "-m", "remote change"]);
    await git(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["config", "remote.origin.push", "+HEAD:refs/heads/main"]);
    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, {
      status: "pending",
      reason: "push_failed",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });

  it("pushes only the current branch when remote.origin.push names other branches", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    await git(dir, ["checkout", "-q", "-b", "leak"]);
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(
      join(dir, "notes", "leak.md"),
      `---\ntitle: "Leak"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "notes/leak.md"]);
    await git(dir, ["commit", "-q", "-m", "leak"]);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, [
      "config",
      "--add",
      "remote.origin.push",
      "refs/heads/leak:refs/heads/leak",
    ]);

    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, { status: "pushed" });
    await assert.rejects(
      git(bare, ["rev-parse", "--verify", "-q", "refs/heads/leak"]),
    );
  });

  it("refuses to push to a mirror remote", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["config", "remote.origin.mirror", "true"]);
    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, {
      status: "pending",
      reason: "push_failed",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });

  it("blocks a merge whose conflict resolution introduces a secret", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["checkout", "-q", "-b", "side"]);
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, "notes", "shared.md"), "side\n");
    await git(dir, ["add", "--", "notes/shared.md"]);
    await git(dir, ["commit", "-q", "-m", "side"]);
    await git(dir, ["checkout", "-q", "main"]);
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(join(dir, "notes", "shared.md"), "main\n");
    await git(dir, ["add", "--", "notes/shared.md"]);
    await git(dir, ["commit", "-q", "-m", "main"]);
    await assert.rejects(git(dir, ["merge", "--no-edit", "side"]));
    await writeFile(
      join(dir, "notes", "shared.md"),
      `---\ntitle: "Merged"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "notes/shared.md"]);
    await git(dir, ["commit", "-q", "--no-edit"]);

    assert.deepEqual(await attemptBackup(dir), {
      status: "blocked",
      reason: "secret_in_unpublished_commit",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });

  it("blocks a commit that changes a published symlink into a file containing a secret", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await mkdir(join(dir, "notes"), { recursive: true });
    const path = join(dir, "notes", "typechange.md");
    await symlink("../README.md", path);
    await git(dir, ["add", "--", "notes/typechange.md"]);
    await git(dir, ["commit", "-q", "-m", "symlink"]);
    assert.deepEqual(await attemptBackup(dir), { status: "pushed" });
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await rm(path);
    await writeFile(path, `Key: ${SECRET_TOKEN}\n`);
    await git(dir, ["add", "--", "notes/typechange.md"]);
    await git(dir, ["commit", "-q", "-m", "typechange"]);

    assert.deepEqual(await attemptBackup(dir), {
      status: "blocked",
      reason: "secret_in_unpublished_commit",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });

  it("pushes to the real branch when a tag has the same name", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    await git(dir, ["tag", "main"]);

    const created = await createItem(dir, "page", input(), "<p>Body.</p>");
    assert.deepEqual(created.backup, { status: "pushed" });
    assert.equal(
      await git(bare, ["rev-parse", "refs/heads/main"]),
      await git(dir, ["rev-parse", "HEAD"]),
    );
    await assert.rejects(
      git(bare, ["rev-parse", "--verify", "-q", "refs/heads/heads/main"]),
    );
  });

  it("blocks the backup when unpublished commits cannot be enumerated", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createItem(dir, "page", input(), "<p>Body.</p>");
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    const previous = process.env.PATH;
    process.env.PATH = `${await makeFailingRevListGit()}${delimiter}${previous}`;
    let created: Awaited<ReturnType<typeof createItem>>;
    try {
      created = await createItem(dir, "page", input(), "<p>Body.</p>");
    } finally {
      process.env.PATH = previous;
    }
    assert.deepEqual(created.backup, {
      status: "blocked",
      reason: "secret_in_unpublished_commit",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });
});
