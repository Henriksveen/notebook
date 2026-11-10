import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_PORT, resolvePort } from "../src/config.ts";
import { itemUrl } from "../src/library.ts";
import { itemBase } from "../src/library-store.ts";
import { assertSafePath, isValidId, resolveDataDir } from "../src/paths.ts";
import { cleanupTempDirs, ID_1, makeTempDir } from "./fixtures.ts";

after(cleanupTempDirs);
const pagePath = (root: string, id: string) =>
  join(root, itemBase("page", id), "index.html");

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
      itemUrl("page", ID_1, 43127),
      `http://127.0.0.1:43127/pages/${ID_1}`,
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
    assert.throws(() => pagePath("/root", "../x"), { code: "USAGE" });
    assert.equal(
      pagePath("/root", ID_1),
      join("/root", "pages", ID_1, "index.html"),
    );
  });
});

describe("path safety", () => {
  it("accepts normal paths inside the root", async () => {
    const root = await makeTempDir();
    await mkdir(join(root, "pages", ID_1), { recursive: true });
    await assertSafePath(root, pagePath(root, ID_1));
  });

  it("rejects symlinked entries directories", async () => {
    const root = await makeTempDir();
    const elsewhere = await makeTempDir();
    await symlink(elsewhere, join(root, "pages"));
    await assert.rejects(assertSafePath(root, pagePath(root, ID_1)), {
      code: "UNSAFE_PATH",
    });
  });

  it("rejects symlinked page files", async () => {
    const root = await makeTempDir();
    const target = join(await makeTempDir(), "outside.md");
    await writeFile(target, "secret");
    await mkdir(join(root, "pages", ID_1), { recursive: true });
    await symlink(target, pagePath(root, ID_1));
    await assert.rejects(assertSafePath(root, pagePath(root, ID_1)), {
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
