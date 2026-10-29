import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_PORT, entryUrl, resolvePort } from "../src/config.ts";
import {
  assertSafePath,
  entryFilePath,
  isValidId,
  resolveDataDir,
} from "../src/paths.ts";
import { ID_1, makeTempDir } from "./fixtures.ts";

describe("data directory resolution", () => {
  it("prefers the flag, then NOTEBOOK_DIR, then ~/notebook", () => {
    assert.equal(
      resolveDataDir({
        flag: "/x/flag",
        env: { NOTEBOOK_DIR: "/x/env" },
        home: "/home/u",
      }),
      "/x/flag",
    );
    assert.equal(
      resolveDataDir({ env: { NOTEBOOK_DIR: "/x/env" }, home: "/home/u" }),
      "/x/env",
    );
    assert.equal(
      resolveDataDir({ env: {}, home: "/home/u" }),
      "/home/u/notebook",
    );
  });
});

describe("port configuration", () => {
  it("defaults to 43127 and honors overrides", () => {
    assert.equal(resolvePort({ env: {} }), DEFAULT_PORT);
    assert.equal(resolvePort({ env: { NOTEBOOK_PORT: "5000" } }), 5000);
    assert.equal(
      resolvePort({ flag: "6000", env: { NOTEBOOK_PORT: "5000" } }),
      6000,
    );
    assert.throws(() => resolvePort({ env: { NOTEBOOK_PORT: "99999" } }));
    assert.equal(
      entryUrl(ID_1, 43127),
      `http://127.0.0.1:43127/entries/${ID_1}`,
    );
  });
});

describe("id validation", () => {
  it("accepts UUID v4 values only", () => {
    assert.equal(isValidId(ID_1), true);
    assert.equal(isValidId(ID_1.toUpperCase()), false);
    assert.equal(isValidId("00000000-0000-1000-8000-000000000000"), false);
    assert.equal(isValidId("../../etc/passwd"), false);
    assert.equal(isValidId(undefined), false);
  });

  it("rejects invalid ids before building a path", () => {
    assert.throws(() => entryFilePath("/root", "../x"), { code: "USAGE" });
    assert.equal(
      entryFilePath("/root", ID_1),
      join("/root", "entries", `${ID_1}.md`),
    );
  });
});

describe("path safety", () => {
  it("accepts normal paths inside the root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "entries"));
    await assertSafePath(root, entryFilePath(root, ID_1));
  });

  it("rejects symlinked entries directories", async () => {
    const root = await makeTempDir();
    const elsewhere = await makeTempDir();
    await symlink(elsewhere, join(root, "entries"));
    await assert.rejects(assertSafePath(root, entryFilePath(root, ID_1)), {
      code: "UNSAFE_PATH",
    });
  });

  it("rejects symlinked entry files", async () => {
    const root = await makeTempDir();
    const target = join(await makeTempDir(), "outside.md");
    await writeFile(target, "secret");
    await mkdir(join(root, "entries"));
    await symlink(target, entryFilePath(root, ID_1));
    await assert.rejects(assertSafePath(root, entryFilePath(root, ID_1)), {
      code: "UNSAFE_PATH",
    });
  });

  it("rejects paths that escape the root", async () => {
    const root = await makeTempDir();
    await assert.rejects(
      assertSafePath(root, join(root, "..", "elsewhere.md")),
      { code: "UNSAFE_PATH" },
    );
    await assert.rejects(assertSafePath(root, root), { code: "UNSAFE_PATH" });
  });
});
