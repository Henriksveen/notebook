import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, entryUrl } from "../src/config.ts";
import { NotebookError } from "../src/errors.ts";
import {
  addAttachment,
  archiveEntry,
  createEntry,
  initNotebook,
  markReady,
  restoreEntry,
  updateEntry,
} from "../src/notebook.ts";
import { lstatOrNull } from "../src/paths.ts";
import { readEntry } from "../src/store.ts";
import {
  commitCount,
  git,
  ID_1,
  makeBareRemote,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

const CREATE_CHILD = fileURLToPath(
  new URL("./helpers/create-child.ts", import.meta.url),
);

function input(title = "Research note", body = "Body text.\n") {
  return {
    title,
    summary: "A short summary.",
    type: "research",
    body,
    topics: ["architecture"],
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<NotebookError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NotebookError) return error;
    throw error;
  }
  throw new Error("expected the operation to fail");
}

function entryPath(dir: string, id: string): string {
  return join(dir, "entries", `${id}.md`);
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

describe("create", () => {
  it("writes one draft entry, commits exactly that path, and reports the result", async () => {
    const dir = await newNotebook();
    const before = await commitCount(dir);
    const result = await createEntry(dir, input());
    assert.equal(result.status, "draft");
    assert.equal(result.url, entryUrl(result.id, DEFAULT_PORT));
    assert.equal(await commitCount(dir), before + 1);
    assert.equal(result.commit, await git(dir, ["rev-parse", "HEAD"]));
    assert.equal(
      await git(dir, ["show", "--format=", "--name-only", "HEAD"]),
      `entries/${result.id}.md`,
    );
    assert.equal(
      await git(dir, ["log", "-1", "--format=%s"]),
      `notebook: create ${result.id} Research note`,
    );
    const bytes = await readFile(entryPath(dir, result.id));
    assert.equal(
      result.revision,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(result.backup, { status: "pending", reason: "no_remote" });
    assert.deepEqual(result.warnings, []);
  });

  it("leaves unrelated staged and unstaged work untouched and uncommitted", async () => {
    const dir = await newNotebook();
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await git(dir, ["add", "staged.txt"]);
    await writeFile(join(dir, "README.md"), "edited by hand\n");
    const result = await createEntry(dir, input());
    assert.equal(
      await git(dir, ["show", "--format=", "--name-only", "HEAD"]),
      `entries/${result.id}.md`,
    );
    const status = await git(dir, ["status", "--porcelain=v1"]);
    assert.match(status, /^A {2}staged\.txt$/m);
    assert.match(status, /^\s*M README\.md$/m);
  });

  it("reports other uncommitted entries as warnings without committing them", async () => {
    const dir = await newNotebook();
    await mkdir(join(dir, "entries"));
    await writeFile(join(dir, "entries", "stray.md"), "left over\n");
    const result = await createEntry(dir, input());
    assert.deepEqual(result.warnings, [
      "uncommitted change not included in this operation: entries/stray.md",
    ]);
    assert.equal(
      await git(dir, ["show", "--format=", "--name-only", "HEAD"]),
      `entries/${result.id}.md`,
    );
  });

  it("rejects managed fields in input without writing anything", async () => {
    const dir = await newNotebook();
    const before = await commitCount(dir);
    const error = await rejectionOf(createEntry(dir, { ...input(), id: ID_1 }));
    assert.equal(error.code, "VALIDATION_FAILED");
    assert.equal(await lstatOrNull(join(dir, "entries")), null);
    assert.equal(await commitCount(dir), before);
  });

  it("blocks secrets in the input with SECRET_DETECTED and no changes", async () => {
    const dir = await newNotebook();
    const before = await commitCount(dir);
    const error = await rejectionOf(
      createEntry(dir, input("Config", "setup\npassword: hunter2hunter2\n")),
    );
    assert.equal(error.code, "SECRET_DETECTED");
    assert.deepEqual(error.details, {
      findings: [{ rule: "credential-assignment", location: "body:line 2" }],
    });
    assert.equal(JSON.stringify(error.details).includes("hunter2"), false);
    assert.equal(await lstatOrNull(join(dir, "entries")), null);
    assert.equal(await commitCount(dir), before);
  });

  it("refuses a directory that is not a notebook without creating state", async () => {
    const dir = await makeTempDir();
    const error = await rejectionOf(createEntry(dir, input()));
    assert.equal(error.code, "NOT_A_NOTEBOOK");
    assert.deepEqual(await readdir(dir), []);
  });

  it("returns REPO_STATE on a detached HEAD", async () => {
    const dir = await newNotebook();
    await git(dir, ["checkout", "--detach"]);
    const error = await rejectionOf(createEntry(dir, input()));
    assert.equal(error.code, "REPO_STATE");
  });

  it("keeps written files and reports COMMIT_FAILED when git commit fails", async () => {
    const dir = await newNotebook();
    const before = await commitCount(dir);
    await git(dir, ["config", "commit.gpgsign", "true"]);
    await git(dir, ["config", "gpg.program", "false"]);
    const error = await rejectionOf(createEntry(dir, input()));
    assert.equal(error.code, "COMMIT_FAILED");
    const details = error.details as { paths: string[]; recovery: string };
    assert.equal(details.paths.length, 1);
    assert.match(details.recovery, /git -C/);
    assert.ok(
      (await readFile(join(dir, details.paths[0]), "utf8")).includes(
        'status: "draft"',
      ),
    );
    assert.equal(await commitCount(dir), before);
  });

  it("runs two concurrent creates in separate processes and keeps both", async () => {
    const dir = await newNotebook();
    const before = await commitCount(dir);
    const run = (title: string) =>
      new Promise<{ status: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [CREATE_CHILD, dir, title], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("close", (code) =>
          code === 0
            ? resolve(JSON.parse(stdout))
            : reject(new Error(`child failed: ${stderr}`)),
        );
      });
    const results = await Promise.all([run("First"), run("Second")]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["draft", "draft"],
    );
    assert.equal(await commitCount(dir), before + 2);
    assert.equal((await readdir(join(dir, "entries"))).length, 2);
  });
});

describe("update", () => {
  it("updates an entry when the revision matches", async () => {
    const dir = await newNotebook();
    const created = await createEntry(dir, input());
    const before = await commitCount(dir);
    const updated = await updateEntry(dir, created.id, created.revision, {
      title: "Renamed note",
    });
    assert.notEqual(updated.revision, created.revision);
    assert.equal(await commitCount(dir), before + 1);
    assert.equal(
      (await readEntry(dir, created.id)).entry.title,
      "Renamed note",
    );
  });

  it("returns DIRTY_TARGET when the entry has uncommitted edits", async () => {
    const dir = await newNotebook();
    const created = await createEntry(dir, input());
    await appendFile(entryPath(dir, created.id), "hand edit\n");
    const before = await readFile(entryPath(dir, created.id));
    const error = await rejectionOf(
      updateEntry(dir, created.id, created.revision, { title: "Other" }),
    );
    assert.equal(error.code, "DIRTY_TARGET");
    assert.deepEqual(await readFile(entryPath(dir, created.id)), before);
  });

  it("returns STALE_REVISION with no file change and no commit", async () => {
    const dir = await newNotebook();
    const created = await createEntry(dir, input());
    const before = await readFile(entryPath(dir, created.id));
    const commits = await commitCount(dir);
    const error = await rejectionOf(
      updateEntry(dir, created.id, "0".repeat(64), { title: "Stale" }),
    );
    assert.equal(error.code, "STALE_REVISION");
    assert.deepEqual(await readFile(entryPath(dir, created.id)), before);
    assert.equal(await commitCount(dir), commits);
  });

  it("returns NOT_FOUND for an unknown id", async () => {
    const dir = await newNotebook();
    const error = await rejectionOf(
      updateEntry(dir, ID_1, "0".repeat(64), { title: "x" }),
    );
    assert.equal(error.code, "NOT_FOUND");
  });
});

describe("status transitions", () => {
  it("moves draft to ready and rejects a second ready", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const ready = await markReady(dir, draft.id, draft.revision);
    assert.equal(ready.status, "ready");
    const error = await rejectionOf(markReady(dir, draft.id, ready.revision));
    assert.equal(error.code, "INVALID_TRANSITION");
  });

  it("archives from ready, restores to ready, and refuses restore when not archived", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const ready = await markReady(dir, draft.id, draft.revision);
    const archived = await archiveEntry(dir, draft.id, ready.revision);
    assert.equal(archived.status, "archived");
    assert.equal((await readEntry(dir, draft.id)).entry.archived_from, "ready");
    const restored = await restoreEntry(dir, draft.id, archived.revision);
    assert.equal(restored.status, "ready");
    assert.equal(
      (await readEntry(dir, draft.id)).entry.archived_from,
      undefined,
    );
    const error = await rejectionOf(
      restoreEntry(dir, draft.id, restored.revision),
    );
    assert.equal(error.code, "INVALID_TRANSITION");
  });

  it("refuses ready on an archived entry and restores a draft archive to draft", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const archived = await archiveEntry(dir, draft.id, draft.revision);
    const ready = await rejectionOf(
      markReady(dir, draft.id, archived.revision),
    );
    assert.equal(ready.code, "INVALID_TRANSITION");
    const restored = await restoreEntry(dir, draft.id, archived.revision);
    assert.equal(restored.status, "draft");
  });
});

describe("attachments", () => {
  it("copies the file, keeps the source, and records size, checksum, and media type", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const source = join(await makeTempDir(), "Photo.PNG");
    const bytes = Buffer.from("fake png bytes");
    await writeFile(source, bytes);
    const result = await addAttachment(dir, draft.id, draft.revision, source);
    const { entry } = await readEntry(dir, draft.id);
    assert.equal(entry.attachments.length, 1);
    const [attachment] = entry.attachments;
    assert.equal(attachment.filename, "Photo.PNG");
    assert.equal(attachment.media_type, "image/png");
    assert.equal(attachment.size, bytes.byteLength);
    assert.equal(
      attachment.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(attachment.stored_as, `${attachment.id}.png`);
    assert.deepEqual(
      await readFile(join(dir, "attachments", draft.id, attachment.stored_as)),
      bytes,
    );
    assert.deepEqual(await readFile(source), bytes);
    const committed = (
      await git(dir, ["show", "--format=", "--name-only", "HEAD"])
    )
      .split("\n")
      .sort();
    assert.deepEqual(committed, [
      `attachments/${draft.id}/${attachment.stored_as}`,
      `entries/${draft.id}.md`,
    ]);
    assert.equal(
      result.revision,
      createHash("sha256")
        .update(await readFile(entryPath(dir, draft.id)))
        .digest("hex"),
    );
  });

  it("uses a default media type for unknown extensions", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const source = join(await makeTempDir(), "data.xyz");
    await writeFile(source, "plain");
    await addAttachment(dir, draft.id, draft.revision, source);
    const [attachment] = (await readEntry(dir, draft.id)).entry.attachments;
    assert.equal(attachment.media_type, "application/octet-stream");
    assert.ok(attachment.stored_as.endsWith(".xyz"));
  });

  it("rejects files over 20 MiB with ATTACHMENT_TOO_LARGE", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const source = join(await makeTempDir(), "big.bin");
    await writeFile(source, "");
    await truncate(source, 20 * 1024 * 1024 + 1);
    const error = await rejectionOf(
      addAttachment(dir, draft.id, draft.revision, source),
    );
    assert.equal(error.code, "ATTACHMENT_TOO_LARGE");
  });

  it("rejects symlink sources with UNSAFE_PATH", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const root = await makeTempDir();
    const real = join(root, "real.txt");
    const link = join(root, "link.txt");
    await writeFile(real, "data");
    await symlink(real, link);
    const error = await rejectionOf(
      addAttachment(dir, draft.id, draft.revision, link),
    );
    assert.equal(error.code, "UNSAFE_PATH");
  });

  it("blocks text attachments containing secrets", async () => {
    const dir = await newNotebook();
    const draft = await createEntry(dir, input());
    const source = join(await makeTempDir(), "env.txt");
    await writeFile(source, "TOKEN=x\napi_key = abcdefgh1234\n");
    const error = await rejectionOf(
      addAttachment(dir, draft.id, draft.revision, source),
    );
    assert.equal(error.code, "SECRET_DETECTED");
    assert.equal(await lstatOrNull(join(dir, "attachments")), null);
  });
});
