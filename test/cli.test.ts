import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { cleanupTempDirs, git, makeTempDir, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);
function run(
  dir: string,
  args: string[],
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["src/cli.ts", "--dir", dir, "--json", ...args],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const page = { title: "Guide", summary: "Visual explanation", kind: "concept" };
it("prints exactly one JSON envelope and initializes idempotently", async () => {
  const dir = join(await makeTempDir(), "new");
  const result = await run(dir, ["init"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).data.created, true);
  const head = await git(dir, ["rev-parse", "HEAD"]);
  assert.equal(
    JSON.parse((await run(dir, ["init"])).stdout).data.created,
    false,
  );
  assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
  assert.equal(
    JSON.parse((await run(dir, ["status"])).stdout).data.repo_ok,
    true,
  );
});
it("accepts UTF-8 page JSON on stdin and returns a stable viewer URL", async () => {
  const dir = await newNotebook(),
    html = join(await makeTempDir(), "page.html");
  await writeFile(html, "<p>Hello</p>");
  const result = await run(
    dir,
    ["page", "create", "--input", "-", "--html", html],
    JSON.stringify({ ...page, title: "Lær Git" }),
  );
  assert.equal(result.code, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.match(saved.data.url, /\/pages\//);
  assert.equal(saved.data.title, "Lær Git");
  assert.equal(saved.backup.reason, "no_remote");
  const loaded = JSON.parse(
    (await run(dir, ["page", "read", saved.data.id])).stdout,
  );
  assert.equal(loaded.data.html, "<p>Hello</p>");
});
it("rejects malformed, oversized and managed input without publishing", async () => {
  const dir = await newNotebook(),
    temp = await makeTempDir(),
    html = join(temp, "page.html");
  await writeFile(html, "<p>Hello</p>");
  const head = await git(dir, ["rev-parse", "HEAD"]);
  for (const input of [
    "{",
    JSON.stringify({ ...page, id: "managed" }),
    JSON.stringify({ ...page, title: "a\nb" }),
    JSON.stringify({ ...page, unused: "a".repeat(4 * 1024 * 1024) }),
  ]) {
    const result = await run(
      dir,
      ["page", "create", "--input", "-", "--html", html],
      input,
    );
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
});
it("blocks secrets in metadata and HTML without echoing matched values", async () => {
  const secret = `ghp_${"A".repeat(36)}`,
    dir = await newNotebook(),
    html = join(await makeTempDir(), "page.html");
  const head = await git(dir, ["rev-parse", "HEAD"]);
  for (const useHtml of [false, true]) {
    await writeFile(html, useHtml ? `<p>${secret}</p>` : "<p>Safe</p>");
    const result = await run(
      dir,
      ["page", "create", "--input", "-", "--html", html],
      JSON.stringify({ ...page, title: useHtml ? "Safe" : secret }),
    );
    assert.equal(JSON.parse(result.stdout).error.code, "SECRET_DETECTED");
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  }
  assert.equal(await git(dir, ["rev-parse", "HEAD"]), head);
});
it("rejects symlink input and reports usage errors before touching data", async () => {
  const dir = await newNotebook(),
    temp = await makeTempDir(),
    html = join(temp, "page.html"),
    link = join(temp, "link.html");
  await writeFile(html, "<p>Safe</p>");
  await symlink(html, link);
  assert.notEqual(
    (
      await run(
        dir,
        ["page", "create", "--input", "-", "--html", link],
        JSON.stringify(page),
      )
    ).code,
    0,
  );
  for (const args of [
    ["page", "create"],
    ["page", "read", "../escape"],
    ["prompt", "create", "--html", html],
    ["serve", "--input", html],
  ])
    assert.notEqual((await run(dir, args)).code, 0);
  assert.equal(await readFile(html, "utf8"), "<p>Safe</p>");
});
