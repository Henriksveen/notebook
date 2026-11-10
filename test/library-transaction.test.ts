import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { publish, recoverTransaction } from "../src/library-transaction.ts";
import { withWriteLock } from "../src/lock.ts";
import { cleanupTempDirs, git, ID_1, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);
const target = `pages/${ID_1}/index.html`;
it("rolls back uncommitted writes and preserves unrelated staged files", async () => {
  const dir = await newNotebook();
  await writeFile(join(dir, "unrelated"), "keep");
  await git(dir, ["add", "unrelated"]);
  await assert.rejects(
    withWriteLock(dir, () =>
      publish(dir, { [target]: "<p>new</p>" }, "test", {
        boundary: (step) => {
          if (step === "write:0") throw new Error("simulated crash");
        },
      }),
    ),
  );
  assert.match(
    await git(dir, ["diff", "--cached", "--name-only"]),
    /unrelated/,
  );
  await assert.rejects(readFile(join(dir, target)));
});
it("keeps a completed commit when cleanup fails", async () => {
  const dir = await newNotebook();
  await assert.rejects(
    withWriteLock(dir, () =>
      publish(dir, { [target]: "<p>new</p>" }, "test", {
        boundary: (step) => {
          if (step === "committed") throw new Error("simulated crash");
        },
      }),
    ),
  );
  await withWriteLock(dir, () => recoverTransaction(dir));
  assert.equal(await readFile(join(dir, target), "utf8"), "<p>new</p>");
  assert.match(await git(dir, ["show", `HEAD:${target}`]), /new/);
});

it("recovers real process crashes at every publication boundary", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir } = await import("node:fs/promises");
  const run = promisify(execFile);
  const context = `pages/${ID_1}/context.md`;
  for (const step of ["journal", "write:0", "write:1", "staged", "committed"]) {
    const dir = await newNotebook();
    await mkdir(join(dir, `pages/${ID_1}`), { recursive: true });
    await writeFile(join(dir, target), "old html");
    await writeFile(join(dir, context), "old context");
    await git(dir, ["add", "pages"]);
    await git(dir, ["commit", "-m", "base"]);
    await assert.rejects(
      run("node", [
        "test/helpers/transaction-child.ts",
        dir,
        step,
        target,
        context,
      ]),
    );
    await withWriteLock(dir, () => recoverTransaction(dir));
    assert.equal(
      await readFile(join(dir, target), "utf8"),
      step === "committed" ? "new html" : "old html",
    );
    if (step === "committed")
      await assert.rejects(readFile(join(dir, context)));
    else
      assert.equal(await readFile(join(dir, context), "utf8"), "old context");
    assert.equal(await git(dir, ["status", "--porcelain"]), "");
  }
});
it("refuses recovery over a manual edit", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await newNotebook();
  await assert.rejects(
    promisify(execFile)("node", [
      "test/helpers/transaction-child.ts",
      dir,
      "write:0",
      target,
      `pages/${ID_1}/context.md`,
    ]),
  );
  await writeFile(join(dir, target), "manual edit");
  await assert.rejects(
    withWriteLock(dir, () => recoverTransaction(dir)),
    /edited/,
  );
  assert.equal(await readFile(join(dir, target), "utf8"), "manual edit");
});

it("a failing Git commit restores the complete prior state", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { delimiter } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await newNotebook();
  const bin = join(dir, ".notebook", "fake-bin");
  await mkdir(bin, { recursive: true });
  const real = (
    await promisify(execFile)("sh", ["-c", "command -v git"])
  ).stdout.trim();
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do\n if [ "$arg" = commit ]; then exit 1; fi\ndone\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous}`;
  try {
    await assert.rejects(
      withWriteLock(dir, () => publish(dir, { [target]: "new" }, "failure")),
      /commit/,
    );
  } finally {
    process.env.PATH = previous;
  }
  assert.equal(await git(dir, ["status", "--porcelain"]), "");
  await assert.rejects(readFile(join(dir, target)));
});
