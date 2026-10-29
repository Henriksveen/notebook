import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/notebook", import.meta.url));
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECRET = `ghp_${"Qz9".repeat(12)}`;

interface World {
  root: string;
  home: string;
  dir: string;
  remote: string;
  port: number;
  env: NodeJS.ProcessEnv;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface Backup {
  status: string;
  reason?: string;
}

interface ErrorBody {
  code: string;
  message: string;
  details?: {
    current_revision?: string;
    findings?: { rule: string; location: string }[];
  };
}

interface Envelope<T> {
  api_version: number;
  ok: boolean;
  data?: T;
  backup?: Backup;
  warnings: string[];
  error?: ErrorBody;
}

interface Call<T> {
  run: Run;
  body: Envelope<T>;
}

interface Mutation {
  id: string;
  title: string;
  status: string;
  url: string;
  revision: string;
  commit: string;
}

interface Attachment {
  id: string;
  filename: string;
  stored_as: string;
  media_type: string;
  size: number;
  sha256: string;
}

interface Read {
  id: string;
  title: string;
  status: string;
  archived_from?: string;
  summary: string;
  body: string;
  revision: string;
  url: string;
  attachments: Attachment[];
}

interface SearchData {
  total: number;
  results: { id: string; title: string }[];
}

interface StatusData {
  repo_ok: boolean;
  remote_configured: boolean;
  unpublished_commits: number;
  last_backup: (Backup & { attempted_at: string }) | null;
}

interface Http {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let stepNumber = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  stepNumber += 1;
  console.log(`step ${stepNumber}: ${name}`);
  await fn();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function runCli(w: World, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, {
      env: w.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
  });
}

async function call<T>(
  w: World,
  args: string[],
  input?: unknown,
): Promise<Call<T>> {
  const run = await runCli(
    w,
    [...args, "--json"],
    input === undefined ? undefined : JSON.stringify(input),
  );
  assert.ok(run.stdout.endsWith("\n"), `stdout must end with a newline`);
  assert.equal(
    run.stdout.trimEnd().includes("\n"),
    false,
    "stdout must be one JSON line",
  );
  return { run, body: JSON.parse(run.stdout) as Envelope<T> };
}

function describeRun(run: Run): string {
  return `exit ${run.code}: ${run.stderr.trim() || run.stdout.trim()}`;
}

function okData<T>(result: Call<T>, label: string): T {
  assert.equal(
    result.run.code,
    0,
    `${label} failed: ${describeRun(result.run)}`,
  );
  assert.equal(result.body.ok, true, `${label} envelope is not ok`);
  assert.ok(result.body.data !== undefined, `${label} returned no data`);
  return result.body.data;
}

function assertError<T>(
  result: Call<T>,
  code: string,
  label: string,
): ErrorBody {
  assert.equal(
    result.run.code,
    1,
    `${label}: expected exit 1, got ${result.run.code}`,
  );
  assert.equal(result.body.ok, false, `${label}: envelope should not be ok`);
  assert.equal(result.body.error?.code, code, `${label}: wrong error code`);
  return result.body.error as ErrorBody;
}

function git(w: World, dir: string, args: string[]): Promise<string> {
  return execFileAsync("git", ["-C", dir, ...args], { env: w.env }).then(
    ({ stdout }) => stdout.trim(),
  );
}

async function commitCount(w: World): Promise<number> {
  return Number(await git(w, w.dir, ["rev-list", "--count", "HEAD"]));
}

async function localHead(w: World): Promise<string> {
  return git(w, w.dir, ["rev-parse", "HEAD"]);
}

async function remoteHead(w: World): Promise<string> {
  return git(w, w.remote, ["rev-parse", "refs/heads/main"]);
}

function entryUrl(w: World, id: string): string {
  return `http://127.0.0.1:${w.port}/entries/${id}`;
}

function http(
  w: World,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Http> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: w.port,
        method,
        path,
        headers: { Host: `127.0.0.1:${w.port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function serverPids(w: World): Promise<number[]> {
  const pattern = `src/cli.ts serve --dir ${escapeRegex(w.dir)} --port`;
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map(Number);
  } catch {
    return [];
  }
}

async function stopServers(w: World): Promise<void> {
  for (const pid of await serverPids(w)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 5000;
  while ((await serverPids(w)).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of await serverPids(w)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

async function assertNoSecretAnywhere(w: World): Promise<void> {
  for (const file of [
    ...(await filesUnder(w.dir)),
    ...(await filesUnder(w.remote)),
  ]) {
    const bytes = await readFile(file);
    assert.equal(bytes.includes(SECRET), false, `secret text found in ${file}`);
  }
  for (const repo of [w.dir, w.remote]) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repo, "cat-file", "--batch-all-objects", "--batch"],
      { env: w.env, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
    );
    assert.equal(
      stdout.includes(SECRET),
      false,
      `secret text found in git objects of ${repo}`,
    );
  }
}

async function setup(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "notebook-e2e-"));
  const home = join(root, "home");
  const gitConfig = join(root, "gitconfig");
  await writeFile(
    gitConfig,
    "[user]\n\tname = E2E Test\n\temail = e2e@example.invalid\n",
  );
  const port = await freePort();
  return {
    root,
    home,
    dir: join(root, "notebook"),
    remote: join(root, "remote.git"),
    port,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      NOTEBOOK_DIR: join(root, "notebook"),
      NOTEBOOK_PORT: String(port),
      LANG: process.env.LANG ?? "C.UTF-8",
    },
  };
}

function createInput(title: string, body: string): Record<string, unknown> {
  return {
    title,
    summary: `Summary for ${title}.`,
    project: "e2e-project",
    topics: ["e2e", "backup"],
    type: "research",
    body,
    sources: [{ kind: "url", url: "https://example.com/docs", title: "Docs" }],
  };
}

async function run(w: World): Promise<void> {
  const body = [
    "## Context",
    "",
    "Needle alpha beta for the end-to-end run.",
    "",
    "## Findings",
    "",
    "- Verified: the create path writes one commit.",
    "",
  ].join("\n");
  let id = "";
  let revision = "";
  let before = 0;

  await step("init with a local bare remote", async () => {
    await git(w, w.root, ["init", "--bare", "-b", "main", w.remote]);
    const result = await call<{ created: boolean; remote: boolean }>(w, [
      "init",
      "--remote",
      w.remote,
    ]);
    const data = okData(result, "init");
    assert.equal(data.created, true);
    assert.equal(data.remote, true);
    assert.equal(
      `${result.run.stdout}${result.run.stderr}`.includes(w.remote),
      false,
      "init must not print the remote",
    );
  });

  await step(
    "create a draft; backup pushes; remote matches local",
    async () => {
      const result = await call<Mutation>(
        w,
        ["create", "--input", "-"],
        createInput("E2E research note", body),
      );
      const data = okData(result, "create");
      id = data.id;
      assert.match(id, UUID);
      assert.equal(data.status, "draft");
      assert.equal(data.url, entryUrl(w, id));
      assert.deepEqual(result.body.backup, { status: "pushed" });
      assert.equal(data.commit, await localHead(w));
      assert.equal(await remoteHead(w), await localHead(w));
      revision = data.revision;
    },
  );

  await step("search finds the entry by a term in its body", async () => {
    const result = await call<SearchData>(w, ["search", "needle", "alpha"]);
    const data = okData(result, "search");
    assert.equal(data.total, 1);
    assert.equal(data.results[0]?.id, id);
  });

  await step("read returns the body and revision", async () => {
    const data = okData(await call<Read>(w, ["read", id]), "read");
    assert.match(data.body, /Needle alpha beta/);
    assert.match(data.revision, /^[0-9a-f]{64}$/);
    assert.equal(data.revision, revision);
    assert.equal(data.url, entryUrl(w, id));
  });

  await step(
    "update with the current revision makes a new revision",
    async () => {
      before = await commitCount(w);
      const result = await call<Mutation>(
        w,
        ["update", id, "--expected-revision", revision, "--input", "-"],
        { summary: "Updated summary for the end-to-end run." },
      );
      const data = okData(result, "update");
      assert.equal(data.id, id);
      assert.equal(data.url, entryUrl(w, id));
      assert.notEqual(data.revision, revision);
      assert.equal(await commitCount(w), before + 1);
      revision = data.revision;
    },
  );

  await step("stale update is refused without a new commit", async () => {
    before = await commitCount(w);
    const stale = await call<Mutation>(
      w,
      ["update", id, "--expected-revision", "0".repeat(64), "--input", "-"],
      { summary: "Should never be written." },
    );
    const error = assertError(stale, "STALE_REVISION", "stale update");
    assert.equal(error.details?.current_revision, revision);
    assert.equal(await commitCount(w), before);
    const current = okData(await call<Read>(w, ["read", id]), "read");
    assert.equal(current.summary, "Updated summary for the end-to-end run.");
  });

  await step(
    "two concurrent creates both succeed and add two commits",
    async () => {
      before = await commitCount(w);
      const [first, second] = await Promise.all([
        call<Mutation>(
          w,
          ["create", "--input", "-"],
          createInput("Concurrent one", "One.\n"),
        ),
        call<Mutation>(
          w,
          ["create", "--input", "-"],
          createInput("Concurrent two", "Two.\n"),
        ),
      ]);
      const a = okData(first, "concurrent create one");
      const b = okData(second, "concurrent create two");
      assert.notEqual(a.id, b.id);
      assert.equal(await commitCount(w), before + 2);
      assert.equal(await remoteHead(w), await localHead(w));
    },
  );

  let pngId = "";
  let htmlId = "";

  await step(
    "attach a PNG and an HTML file, then reference them in the body",
    async () => {
      await writeFile(join(w.root, "pixel.png"), PNG_BYTES);
      await writeFile(join(w.root, "report.html"), "<h1>Report</h1>\n");
      const png = await call<Mutation>(w, [
        "attach",
        id,
        "--expected-revision",
        revision,
        "--file",
        join(w.root, "pixel.png"),
        "--name",
        "pixel.png",
      ]);
      revision = okData(png, "attach png").revision;
      const html = await call<Mutation>(w, [
        "attach",
        id,
        "--expected-revision",
        revision,
        "--file",
        join(w.root, "report.html"),
        "--name",
        "report.html",
      ]);
      revision = okData(html, "attach html").revision;

      const current = okData(await call<Read>(w, ["read", id]), "read");
      assert.equal(current.attachments.length, 2);
      const png1 = current.attachments.find((a) => a.filename === "pixel.png");
      const html1 = current.attachments.find(
        (a) => a.filename === "report.html",
      );
      assert.ok(png1 && html1, "both attachments are listed");
      pngId = png1.id;
      htmlId = html1.id;
      assert.equal(png1.media_type, "image/png");
      assert.equal(html1.media_type, "text/html");
      assert.equal(png1.size, PNG_BYTES.byteLength);

      const updated = await call<Mutation>(
        w,
        ["update", id, "--expected-revision", current.revision, "--input", "-"],
        {
          body: `${current.body}\n![pixel](attachment:${pngId})\n\n[report](attachment:${htmlId})\n`,
        },
      );
      revision = okData(updated, "update with attachment links").revision;
    },
  );

  await step(
    "ready, archive, and restore follow the state machine",
    async () => {
      const ready = okData(
        await call<Mutation>(w, ["ready", id, "--expected-revision", revision]),
        "ready",
      );
      assert.equal(ready.status, "ready");
      revision = ready.revision;

      const archived = okData(
        await call<Mutation>(w, [
          "archive",
          id,
          "--expected-revision",
          revision,
        ]),
        "archive",
      );
      assert.equal(archived.status, "archived");
      revision = archived.revision;
      const archivedRead = okData(
        await call<Read>(w, ["read", id]),
        "read archived",
      );
      assert.equal(archivedRead.archived_from, "ready");
      const hidden = okData(
        await call<SearchData>(w, ["search", "needle"]),
        "search hidden",
      );
      assert.equal(
        hidden.total,
        0,
        "archived entries are hidden from default search",
      );

      const invalid = await call<Mutation>(w, [
        "ready",
        id,
        "--expected-revision",
        revision,
      ]);
      assertError(invalid, "INVALID_TRANSITION", "ready from archived");

      const restored = okData(
        await call<Mutation>(w, [
          "restore",
          id,
          "--expected-revision",
          revision,
        ]),
        "restore",
      );
      assert.equal(restored.status, "ready");
      revision = restored.revision;
      const restoredRead = okData(
        await call<Read>(w, ["read", id]),
        "read restored",
      );
      assert.equal(restoredRead.archived_from, undefined);
    },
  );

  await step(
    "a secret is refused, then a redacted retry succeeds",
    async () => {
      before = await commitCount(w);
      const blocked = await call<Mutation>(
        w,
        ["create", "--input", "-"],
        createInput("Deploy notes", `Build token: ${SECRET}\n`),
      );
      const error = assertError(blocked, "SECRET_DETECTED", "secret create");
      assert.ok(
        error.details?.findings?.some(
          (finding) => finding.rule === "github-token",
        ),
        "the finding names the rule",
      );
      const output = `${blocked.run.stdout}${blocked.run.stderr}`;
      assert.equal(
        output.includes(SECRET),
        false,
        "secret text must not be printed",
      );
      assert.equal(await commitCount(w), before);

      const retried = okData(
        await call<Mutation>(
          w,
          ["create", "--input", "-"],
          createInput(
            "Deploy notes",
            "The build token was kept out of this entry; see the CI secret store.\n",
          ),
        ),
        "redacted create",
      );
      assert.equal(retried.status, "draft");
      await assertNoSecretAnywhere(w);
    },
  );

  await step(
    "unrelated staged and unstaged work is preserved and not committed",
    async () => {
      await writeFile(join(w.dir, "unrelated-staged.txt"), "staged\n");
      await git(w, w.dir, ["add", "--", "unrelated-staged.txt"]);
      await appendFile(join(w.dir, "README.md"), "\nLocal scratch edit.\n");
      await writeFile(join(w.dir, "scratch.txt"), "untracked\n");

      const created = okData(
        await call<Mutation>(
          w,
          ["create", "--input", "-"],
          createInput("Isolated commit", "Only this file.\n"),
        ),
        "isolated create",
      );
      const files = await git(w, w.dir, [
        "show",
        "--name-only",
        "--format=",
        "HEAD",
      ]);
      assert.equal(files, `entries/${created.id}.md`);
      assert.equal(
        (await git(w, w.dir, ["diff", "--cached", "--name-only"])).includes(
          "unrelated-staged.txt",
        ),
        true,
      );
      assert.equal(
        (await git(w, w.dir, ["diff", "--name-only"])).includes("README.md"),
        true,
      );
      assert.equal(
        (
          await git(w, w.dir, ["ls-files", "--others", "--exclude-standard"])
        ).includes("scratch.txt"),
        true,
      );
    },
  );

  await step(
    "a broken remote reports pending with exit 0, and status shows it",
    async () => {
      await git(w, w.dir, [
        "remote",
        "set-url",
        "origin",
        join(w.root, "missing.git"),
      ]);
      const result = await call<Mutation>(
        w,
        ["create", "--input", "-"],
        createInput("Offline note", "Saved while the remote is down.\n"),
      );
      const data = okData(result, "create with broken remote");
      assert.equal(result.run.code, 0);
      assert.deepEqual(result.body.backup, {
        status: "pending",
        reason: "push_failed",
      });
      assert.equal(
        `${result.run.stdout}${result.run.stderr}`.includes("missing.git"),
        false,
        "remote path must not be printed",
      );
      const status = okData(await call<StatusData>(w, ["status"]), "status");
      assert.equal(status.remote_configured, true);
      assert.equal(status.unpublished_commits, 1);
      assert.equal(status.last_backup?.status, "pending");
      assert.equal(data.status, "draft");
    },
  );

  await step(
    "fixing the remote and running backup publishes everything",
    async () => {
      await git(w, w.dir, ["remote", "set-url", "origin", w.remote]);
      const result = await call<Record<string, never>>(w, ["backup"]);
      okData(result, "backup");
      assert.deepEqual(result.body.backup, { status: "pushed" });
      assert.equal(await remoteHead(w), await localHead(w));
      const status = okData(await call<StatusData>(w, ["status"]), "status");
      assert.equal(status.unpublished_commits, 0);
      assert.equal(status.last_backup?.status, "pushed");
    },
  );

  await step(
    "open starts the website, serves pages, and enforces security rules",
    async () => {
      const opened = await call<{ url: string; reused: boolean }>(w, [
        "open",
        "--no-browser",
      ]);
      const data = okData(opened, "open");
      assert.deepEqual(data, {
        url: `http://127.0.0.1:${w.port}/`,
        reused: false,
      });
      assert.deepEqual(opened.body.warnings, []);
      assert.equal((await serverPids(w)).length, 1);

      const home = await http(w, "GET", "/");
      assert.equal(home.status, 200);
      assert.match(home.body.toString("utf8"), /E2E research note/);
      assert.equal(home.headers["content-security-policy"], CSP);
      assert.equal(home.headers["x-content-type-options"], "nosniff");
      assert.equal(home.headers["referrer-policy"], "no-referrer");
      assert.equal(home.headers["x-frame-options"], "DENY");

      const page = await http(w, "GET", `/entries/${id}`);
      assert.equal(page.status, 200);
      const pageHtml = page.body.toString("utf8");
      assert.match(pageHtml, /Needle alpha beta/);
      assert.equal(
        pageHtml.includes('class="banner"'),
        false,
        "ready entries have no banner",
      );
      assert.ok(
        pageHtml.includes(`/attachments/${id}/${pngId}`),
        "PNG is rendered from the entry",
      );

      const health = await http(w, "GET", "/_health");
      assert.equal(health.status, 200);
      const healthBody = JSON.parse(health.body.toString("utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(healthBody.app, "notebook");
      assert.equal(healthBody.api_version, 1);
      assert.equal(typeof healthBody.fingerprint, "string");

      const png = await http(w, "GET", `/attachments/${id}/${pngId}`);
      assert.equal(png.status, 200);
      assert.equal(png.headers["content-type"], "image/png");
      assert.match(String(png.headers["content-disposition"]), /^inline;/);
      assert.equal(png.body.equals(PNG_BYTES), true);

      const html = await http(w, "GET", `/attachments/${id}/${htmlId}`);
      assert.equal(html.status, 200);
      assert.equal(html.headers["content-type"], "application/octet-stream");
      assert.match(String(html.headers["content-disposition"]), /^attachment;/);

      assert.equal(
        (await http(w, "GET", "/", { Host: "evil.example" })).status,
        421,
      );
      assert.equal(
        (await http(w, "GET", "/", { Host: `localhost:${w.port}` })).status,
        200,
      );
      assert.equal((await http(w, "POST", "/")).status, 405);
    },
  );

  await step(
    "an archived entry shows the banner and leaves the home page",
    async () => {
      const archived = okData(
        await call<Mutation>(w, [
          "archive",
          id,
          "--expected-revision",
          revision,
        ]),
        "archive for banner",
      );
      revision = archived.revision;
      const page = await http(w, "GET", `/entries/${id}`);
      assert.equal(page.status, 200);
      assert.match(page.body.toString("utf8"), /class="banner"/);
      assert.match(page.body.toString("utf8"), /Archived/);
      const home = await http(w, "GET", "/");
      assert.equal(
        home.body.toString("utf8").includes("E2E research note"),
        false,
      );
      assert.equal(
        (await http(w, "GET", `/attachments/${id}/${pngId}`)).status,
        200,
      );
    },
  );

  await step("a second open reuses the running website", async () => {
    const reopened = await call<{ url: string; reused: boolean }>(w, [
      "open",
      id,
      "--no-browser",
    ]);
    const data = okData(reopened, "second open");
    assert.deepEqual(data, { url: entryUrl(w, id), reused: true });
    assert.equal((await serverPids(w)).length, 1);
  });

  await step("stopping the website leaves no server behind", async () => {
    const pids = await serverPids(w);
    assert.equal(pids.length, 1, "exactly one website process");
    for (const pid of pids) process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while ((await serverPids(w)).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(await serverPids(w), []);
    await assert.rejects(http(w, "GET", "/_health"));
  });
}

async function main(): Promise<void> {
  const w = await setup();
  try {
    await run(w);
    console.log(`E2E passed: ${stepNumber} steps`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`E2E FAILED at step ${stepNumber}: ${message}`);
    process.exitCode = 1;
  } finally {
    await stopServers(w);
    await rm(w.root, { recursive: true, force: true });
  }
}

await main();
