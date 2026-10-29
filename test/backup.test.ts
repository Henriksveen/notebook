import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { attemptBackup, readBackupState } from "../src/backup.ts";
import { createEntry, initNotebook } from "../src/notebook.ts";
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
    type: "note",
    body: "Body.\n",
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
    const created = await createEntry(dir, input());
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
    const created = await createEntry(dir, input());
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
    await createEntry(dir, input());
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

  it("blocks a manually committed secret in entries/ and does not push it", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await mkdir(join(dir, "entries"));
    await writeFile(
      join(dir, "entries", `${ID_1}.md`),
      `---\ntitle: "Manual"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "entries"]);
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
    await createEntry(dir, input());

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
    await createEntry(dir, input());
    const other = join(await makeTempDir(), "other");
    await git(dirname(other), ["clone", "-q", bare, other]);
    await git(other, ["commit", "-q", "--allow-empty", "-m", "remote change"]);
    await git(other, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["config", "remote.origin.push", "+HEAD:refs/heads/main"]);
    const created = await createEntry(dir, input());
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
    await createEntry(dir, input());
    await git(dir, ["checkout", "-q", "-b", "leak"]);
    await writeFile(
      join(dir, "entries", "leak.md"),
      `---\ntitle: "Leak"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "entries/leak.md"]);
    await git(dir, ["commit", "-q", "-m", "leak"]);
    await git(dir, ["checkout", "-q", "main"]);
    await git(dir, [
      "config",
      "--add",
      "remote.origin.push",
      "refs/heads/leak:refs/heads/leak",
    ]);

    const created = await createEntry(dir, input());
    assert.deepEqual(created.backup, { status: "pushed" });
    await assert.rejects(
      git(bare, ["rev-parse", "--verify", "-q", "refs/heads/leak"]),
    );
  });

  it("refuses to push to a mirror remote", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createEntry(dir, input());
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["config", "remote.origin.mirror", "true"]);
    const created = await createEntry(dir, input());
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
    await createEntry(dir, input());
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    await git(dir, ["checkout", "-q", "-b", "side"]);
    await writeFile(join(dir, "entries", "shared.md"), "side\n");
    await git(dir, ["add", "--", "entries/shared.md"]);
    await git(dir, ["commit", "-q", "-m", "side"]);
    await git(dir, ["checkout", "-q", "main"]);
    await writeFile(join(dir, "entries", "shared.md"), "main\n");
    await git(dir, ["add", "--", "entries/shared.md"]);
    await git(dir, ["commit", "-q", "-m", "main"]);
    await assert.rejects(git(dir, ["merge", "--no-edit", "side"]));
    await writeFile(
      join(dir, "entries", "shared.md"),
      `---\ntitle: "Merged"\n---\nKey: ${SECRET_TOKEN}\n`,
    );
    await git(dir, ["add", "--", "entries/shared.md"]);
    await git(dir, ["commit", "-q", "--no-edit"]);

    assert.deepEqual(await attemptBackup(dir), {
      status: "blocked",
      reason: "secret_in_unpublished_commit",
    });
    assert.equal(await git(bare, ["rev-parse", "main"]), remoteBefore);
  });

  it("blocks the backup when unpublished commits cannot be enumerated", async () => {
    const dir = await newNotebook();
    const bare = await makeBareRemote();
    await initNotebook(dir, { remote: bare });
    await createEntry(dir, input());
    const remoteBefore = await git(bare, ["rev-parse", "main"]);

    const previous = process.env.PATH;
    process.env.PATH = `${await makeFailingRevListGit()}${delimiter}${previous}`;
    let created: Awaited<ReturnType<typeof createEntry>>;
    try {
      created = await createEntry(dir, input());
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
