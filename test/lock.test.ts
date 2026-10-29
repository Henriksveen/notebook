import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { withWriteLock } from "../src/lock.ts";
import { makeTempDir } from "./fixtures.ts";

const CHILD = fileURLToPath(
  new URL("./helpers/lock-child.ts", import.meta.url),
);

function runChild(dir: string, log: string, holdMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dir, log, String(holdMs)], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`child exited ${code}`)),
    );
  });
}

describe("write lock", () => {
  it("serializes two concurrent processes", async () => {
    const dir = await makeTempDir();
    const log = join(dir, "log.txt");
    await Promise.all([runChild(dir, log, 300), runChild(dir, log, 300)]);
    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^start \d+$/);
    assert.match(lines[1], /^end \d+$/);
    assert.match(lines[2], /^start \d+$/);
    assert.match(lines[3], /^end \d+$/);
    assert.equal(lines[0].split(" ")[1], lines[1].split(" ")[1]);
    assert.equal(lines[2].split(" ")[1], lines[3].split(" ")[1]);
  });

  it("times out with LOCK_TIMEOUT while another holder keeps the lock", async () => {
    const dir = await makeTempDir();
    await withWriteLock(dir, async () => {
      await assert.rejects(
        withWriteLock(dir, async () => undefined, { timeoutMs: 100 }),
        { code: "LOCK_TIMEOUT" },
      );
    });
  });

  it("releases the lock when the callback throws", async () => {
    const dir = await makeTempDir();
    await assert.rejects(
      withWriteLock(dir, async () => {
        throw new Error("boom");
      }),
      { message: "boom" },
    );
    assert.equal(await withWriteLock(dir, async () => "again"), "again");
  });

  it("creates .notebook with mode 0700 and never deletes the lock file", async () => {
    const dir = await makeTempDir();
    await withWriteLock(dir, async () => undefined);
    const runtime = await stat(join(dir, ".notebook"));
    assert.equal(runtime.mode & 0o777, 0o700);
    assert.ok((await stat(join(dir, ".notebook", "write.lock"))).isFile());
  });
});
