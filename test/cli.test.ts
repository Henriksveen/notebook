import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cleanupTempDirs,
  git,
  makeBareRemote,
  makeTempDir,
} from "./fixtures.ts";

after(cleanupTempDirs);

const BIN = fileURLToPath(new URL("../bin/notebook", import.meta.url));
const SECRET = `ghp_${"A".repeat(36)}`;
const SECRET_BODY = `Token for the build: ${SECRET}\n`;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Sandbox {
  home: string;
  dir: string;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface Envelope {
  api_version: number;
  ok: boolean;
  data?: Record<string, unknown>;
  backup?: Record<string, unknown>;
  warnings: unknown[];
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.NOTEBOOK_DIR;
  delete env.NOTEBOOK_PORT;
  delete env.NOTEBOOK_DEBUG;
  return env;
}

function runProcess(
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; input?: string },
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: options.env,
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
    child.once("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

async function newSandbox(): Promise<Sandbox> {
  const root = await makeTempDir();
  const sandbox = { home: join(root, "home"), dir: join(root, "notebook") };
  await mkdir(sandbox.home);
  const result = await cli(sandbox, ["init", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  return sandbox;
}

function cli(
  sandbox: Sandbox,
  args: string[],
  input?: string,
): Promise<Result> {
  return runProcess(BIN, ["--dir", sandbox.dir, ...args], {
    env: sandboxEnv(sandbox.home),
    input,
  });
}

function parseEnvelope(result: Result): Envelope {
  assert.ok(result.stdout.endsWith("\n"), "stdout ends with a newline");
  assert.equal(result.stdout.trimEnd().includes("\n"), false);
  return JSON.parse(result.stdout) as Envelope;
}

async function entryFiles(sandbox: Sandbox): Promise<string[]> {
  try {
    return await readdir(join(sandbox.dir, "entries"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function field(
  object: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = object?.[key];
  assert.equal(typeof value, "string", `${key} should be a string`);
  return value as string;
}

function draftInput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Research note",
    summary: "A short summary.",
    type: "research",
    body: "Body text.\n",
    topics: ["architecture"],
    ...overrides,
  });
}

async function createDraft(
  sandbox: Sandbox,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; revision: string }> {
  const result = await cli(
    sandbox,
    ["create", "--input", "-", "--json"],
    draftInput(overrides),
  );
  assert.equal(result.code, 0, result.stdout);
  const data = parseEnvelope(result).data;
  return { id: field(data, "id"), revision: field(data, "revision") };
}

async function expectError(
  result: Result,
  code: string,
  exitCode: number,
): Promise<Envelope> {
  assert.equal(result.code, exitCode, result.stdout + result.stderr);
  const envelope = parseEnvelope(result);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, code);
  return envelope;
}

describe("init", () => {
  it("creates the notebook and reports it as JSON", async () => {
    const root = await makeTempDir();
    const dir = join(root, "nb");
    const result = await runProcess(BIN, ["--dir", dir, "--json", "init"], {
      env: sandboxEnv(join(root, "home")),
    });
    assert.equal(result.code, 0, result.stderr);
    const envelope = parseEnvelope(result);
    assert.equal(envelope.api_version, 1);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data?.created, true);
    assert.equal(envelope.data?.remote, false);
    assert.equal(
      await readFile(join(dir, ".gitignore"), "utf8"),
      ".notebook/\n",
    );
  });

  it("adds a remote without printing its URL", async () => {
    const sandbox = await newSandbox();
    const bare = await makeBareRemote();
    const result = await cli(sandbox, ["init", "--remote", bare, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(bare), false);
    assert.equal(parseEnvelope(result).data?.remote, true);
  });
});

describe("create", () => {
  it("creates a draft from stdin and reports the mutation envelope", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      draftInput(),
    );
    assert.equal(result.code, 0, result.stderr);
    const envelope = parseEnvelope(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.api_version, 1);
    assert.deepEqual(envelope.warnings, []);
    assert.deepEqual(envelope.backup, {
      status: "pending",
      reason: "no_remote",
    });
    const data = envelope.data;
    const id = field(data, "id");
    assert.match(id, UUID);
    assert.equal(data?.title, "Research note");
    assert.equal(data?.status, "draft");
    assert.equal(data?.url, `http://127.0.0.1:43127/entries/${id}`);
    assert.match(field(data, "revision"), /^[0-9a-f]{64}$/);
    assert.match(field(data, "commit"), /^[0-9a-f]{40}$/);
  });

  it("creates a draft from a file", async () => {
    const sandbox = await newSandbox();
    const file = join(await makeTempDir(), "entry.json");
    await writeFile(file, draftInput({ title: "From file" }));
    const result = await cli(sandbox, ["create", "--input", file, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseEnvelope(result).data?.title, "From file");
  });

  it("writes exactly one JSON object to stdout and nothing to stderr", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      draftInput(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    parseEnvelope(result);
  });

  it("rejects managed fields in the input", async () => {
    const sandbox = await newSandbox();
    for (const key of [
      { id: "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b" },
      { status: "ready" },
      { created_at: "2026-10-29T12:00:00.000Z" },
      { updated_at: "2026-10-29T12:00:00.000Z" },
      { attachments: [] },
    ]) {
      const result = await cli(
        sandbox,
        ["create", "--input", "-", "--json"],
        draftInput(key),
      );
      await expectError(result, "VALIDATION_FAILED", 1);
    }
    assert.deepEqual(await entryFiles(sandbox), []);
  });

  it("reports invalid JSON as VALIDATION_FAILED", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      "{not json",
    );
    await expectError(result, "VALIDATION_FAILED", 1);
  });

  it("prints the URL and backup line in human mode", async () => {
    const sandbox = await newSandbox();
    const result = await cli(sandbox, ["create", "--input", "-"], draftInput());
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      result.stdout,
      /URL: http:\/\/127\.0\.0\.1:43127\/entries\/[0-9a-f-]{36}/,
    );
    assert.match(result.stdout, /Saved locally; backup pending \(no_remote\)/);
    assert.equal(result.stdout.trimStart().startsWith("{"), false);
  });

  it("honors --port for the entry URL", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["create", "--input", "-", "--json", "--port", "5555"],
      draftInput(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(field(parseEnvelope(result).data, "url"), /:5555\/entries\//);
  });
});

describe("read", () => {
  it("returns metadata, body, revision, and URL", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const result = await cli(sandbox, ["read", created.id, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const data = parseEnvelope(result).data;
    assert.equal(data?.id, created.id);
    assert.equal(data?.status, "draft");
    assert.equal(data?.body, "Body text.\n");
    assert.equal(data?.revision, created.revision);
    assert.equal(data?.url, `http://127.0.0.1:43127/entries/${created.id}`);
    assert.deepEqual(data?.attachments, []);
  });

  it("reports NOT_FOUND and USAGE errors", async () => {
    const sandbox = await newSandbox();
    await expectError(
      await cli(sandbox, [
        "read",
        "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b",
        "--json",
      ]),
      "NOT_FOUND",
      1,
    );
    await expectError(
      await cli(sandbox, ["read", "nope", "--json"]),
      "USAGE",
      2,
    );
  });
});

describe("search", () => {
  it("normalizes human-written topics and filters by them", async () => {
    const sandbox = await newSandbox();
    await createDraft(sandbox, { topics: ["Smoke Test", "Café / Ops"] });
    const result = await cli(sandbox, [
      "search",
      "--topic",
      "Smoke Test",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stdout);
    const data = parseEnvelope(result).data as {
      total: number;
      results: { topics: string[] }[];
    };
    assert.equal(data.total, 1);
    assert.deepEqual(data.results[0]?.topics, ["cafe-ops", "smoke-test"]);
  });

  it("reports NOT_A_NOTEBOOK for a missing notebook directory", async () => {
    const root = await makeTempDir();
    const sandbox = { home: join(root, "home"), dir: join(root, "missing") };
    await mkdir(sandbox.home);
    await expectError(
      await cli(sandbox, ["search", "--json"]),
      "NOT_A_NOTEBOOK",
      1,
    );
    await expectError(
      await cli(sandbox, [
        "read",
        "11111111-1111-4111-8111-111111111111",
        "--json",
      ]),
      "NOT_A_NOTEBOOK",
      1,
    );
  });

  it("filters, paginates, and excludes archived entries by default", async () => {
    const sandbox = await newSandbox();
    await createDraft(sandbox, {
      title: "Kubernetes rollout",
      body: "Notes about kubernetes.\n",
      project: "Work",
      type: "research",
    });
    const idea = await createDraft(sandbox, {
      title: "Garden idea",
      summary: "Plant herbs.",
      body: "Basil and mint.\n",
      type: "idea",
    });
    const archivedSource = await createDraft(sandbox, {
      title: "Old kubernetes plan",
      body: "Legacy.\n",
    });
    const archive = await cli(sandbox, [
      "archive",
      archivedSource.id,
      "--expected-revision",
      archivedSource.revision,
      "--json",
    ]);
    assert.equal(archive.code, 0, archive.stderr);

    const byQuery = parseEnvelope(
      await cli(sandbox, ["search", "kubernetes", "--json"]),
    );
    assert.equal(byQuery.data?.total, 1);
    const results = byQuery.data?.results as Array<Record<string, unknown>>;
    assert.equal(results[0]?.title, "Kubernetes rollout");

    const byType = parseEnvelope(
      await cli(sandbox, ["search", "--type", "idea", "--json"]),
    );
    assert.equal(byType.data?.total, 1);
    const typed = (byType.data?.results ?? []) as Array<
      Record<string, unknown>
    >;
    assert.equal(typed[0]?.id, idea.id);

    const byProject = parseEnvelope(
      await cli(sandbox, ["search", "--project", "work", "--json"]),
    );
    assert.equal(byProject.data?.total, 1);

    const withArchived = parseEnvelope(
      await cli(sandbox, [
        "search",
        "kubernetes",
        "--include-archived",
        "--json",
      ]),
    );
    assert.equal(withArchived.data?.total, 2);

    const page = parseEnvelope(
      await cli(sandbox, [
        "search",
        "--include-archived",
        "--limit",
        "1",
        "--offset",
        "1",
        "--json",
      ]),
    );
    assert.equal(page.data?.total, 3);
    assert.equal(((page.data?.results ?? []) as unknown[]).length, 1);
  });

  it("rejects an unknown status filter as USAGE", async () => {
    const sandbox = await newSandbox();
    await expectError(
      await cli(sandbox, ["search", "--status", "deleted", "--json"]),
      "USAGE",
      2,
    );
  });
});

describe("update", () => {
  it("applies a change with the current revision", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const result = await cli(
      sandbox,
      [
        "update",
        created.id,
        "--expected-revision",
        created.revision,
        "--input",
        "-",
        "--json",
      ],
      JSON.stringify({ title: "Renamed note" }),
    );
    assert.equal(result.code, 0, result.stderr);
    const data = parseEnvelope(result).data;
    assert.equal(data?.title, "Renamed note");
    assert.notEqual(data?.revision, created.revision);
    const read = parseEnvelope(
      await cli(sandbox, ["read", created.id, "--json"]),
    );
    assert.equal(read.data?.title, "Renamed note");
  });

  it("reports STALE_REVISION with the current revision and changes nothing", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const stale = "0".repeat(64);
    const result = await cli(
      sandbox,
      [
        "update",
        created.id,
        "--expected-revision",
        stale,
        "--input",
        "-",
        "--json",
      ],
      JSON.stringify({ title: "Should not land" }),
    );
    const envelope = await expectError(result, "STALE_REVISION", 1);
    assert.equal(envelope.error?.details?.current_revision, created.revision);
    const read = parseEnvelope(
      await cli(sandbox, ["read", created.id, "--json"]),
    );
    assert.equal(read.data?.title, "Research note");
  });

  it("requires --input and --expected-revision", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    await expectError(
      await cli(sandbox, [
        "update",
        created.id,
        "--expected-revision",
        created.revision,
        "--json",
      ]),
      "USAGE",
      2,
    );
    await expectError(
      await cli(
        sandbox,
        ["update", created.id, "--input", "-", "--json"],
        "{}",
      ),
      "USAGE",
      2,
    );
  });
});

describe("ready, archive, and restore", () => {
  it("walks draft -> ready -> archived -> restored and rejects invalid transitions", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);

    const ready = await cli(sandbox, [
      "ready",
      created.id,
      "--expected-revision",
      created.revision,
      "--json",
    ]);
    assert.equal(ready.code, 0, ready.stderr);
    const readyData = parseEnvelope(ready).data;
    assert.equal(readyData?.status, "ready");
    const readyRevision = field(readyData, "revision");

    await expectError(
      await cli(sandbox, [
        "ready",
        created.id,
        "--expected-revision",
        readyRevision,
        "--json",
      ]),
      "INVALID_TRANSITION",
      1,
    );

    const archived = await cli(sandbox, [
      "archive",
      created.id,
      "--expected-revision",
      readyRevision,
      "--json",
    ]);
    assert.equal(archived.code, 0, archived.stderr);
    const archivedData = parseEnvelope(archived).data;
    assert.equal(archivedData?.status, "archived");
    const archivedRevision = field(archivedData, "revision");

    await expectError(
      await cli(sandbox, [
        "ready",
        created.id,
        "--expected-revision",
        archivedRevision,
        "--json",
      ]),
      "INVALID_TRANSITION",
      1,
    );

    const restored = await cli(sandbox, [
      "restore",
      created.id,
      "--expected-revision",
      archivedRevision,
      "--json",
    ]);
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(parseEnvelope(restored).data?.status, "ready");
  });
});

describe("attach", () => {
  it("copies the file, keeps the source, and lists the attachment", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const source = join(await makeTempDir(), "diagram.png");
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
    await writeFile(source, bytes);

    const result = await cli(sandbox, [
      "attach",
      created.id,
      "--expected-revision",
      created.revision,
      "--file",
      source,
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const attached = parseEnvelope(result).data;
    assert.equal(attached?.id, created.id);
    assert.deepEqual(await readFile(source), bytes);

    const read = parseEnvelope(
      await cli(sandbox, ["read", created.id, "--json"]),
    );
    const attachments = read.data?.attachments as Array<
      Record<string, unknown>
    >;
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]?.filename, "diagram.png");
    assert.equal(attachments[0]?.media_type, "image/png");
    assert.equal(attachments[0]?.size, bytes.byteLength);
    assert.deepEqual(attached?.attachment, {
      id: attachments[0]?.id,
      filename: "diagram.png",
      media_type: "image/png",
      size: bytes.byteLength,
      ref: `attachment:${attachments[0]?.id}`,
    });
    assert.equal(attached?.revision, read.data?.revision);
  });

  it("honors --name, rejects a missing file, and rejects a symlink", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const root = await makeTempDir();
    const source = join(root, "notes.bin");
    await writeFile(source, "plain text");
    const named = parseEnvelope(
      await cli(sandbox, [
        "attach",
        created.id,
        "--expected-revision",
        created.revision,
        "--file",
        source,
        "--name",
        "renamed.txt",
        "--json",
      ]),
    );
    assert.equal(named.ok, true);
    const read = parseEnvelope(
      await cli(sandbox, ["read", created.id, "--json"]),
    );
    const attachments = read.data?.attachments as Array<
      Record<string, unknown>
    >;
    assert.equal(attachments[0]?.filename, "renamed.txt");

    const current = field(read.data, "revision");
    await expectError(
      await cli(sandbox, [
        "attach",
        created.id,
        "--expected-revision",
        current,
        "--file",
        join(root, "missing.txt"),
        "--json",
      ]),
      "NOT_FOUND",
      1,
    );

    const link = join(root, "link.txt");
    await symlink(source, link);
    await expectError(
      await cli(sandbox, [
        "attach",
        created.id,
        "--expected-revision",
        current,
        "--file",
        link,
        "--json",
      ]),
      "UNSAFE_PATH",
      1,
    );
  });
});

describe("validate", () => {
  it("validates input without writing anything", async () => {
    const sandbox = await newSandbox();
    const ok = await cli(
      sandbox,
      ["validate", "--input", "-", "--json"],
      draftInput(),
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(parseEnvelope(ok).data?.valid, true);
    assert.deepEqual(await entryFiles(sandbox), []);

    await expectError(
      await cli(
        sandbox,
        ["validate", "--input", "-", "--json"],
        draftInput({ title: "" }),
      ),
      "VALIDATION_FAILED",
      1,
    );
  });

  it("validates a stored entry by ID", async () => {
    const sandbox = await newSandbox();
    const created = await createDraft(sandbox);
    const result = await cli(sandbox, ["validate", created.id, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseEnvelope(result).data?.revision, created.revision);
  });

  it("requires exactly one of --input or ID", async () => {
    const sandbox = await newSandbox();
    await expectError(await cli(sandbox, ["validate", "--json"]), "USAGE", 2);
    await expectError(
      await cli(
        sandbox,
        [
          "validate",
          "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b",
          "--input",
          "-",
          "--json",
        ],
        draftInput(),
      ),
      "USAGE",
      2,
    );
  });

  it("blocks secrets during validation", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["validate", "--input", "-", "--json"],
      draftInput({ body: SECRET_BODY }),
    );
    await expectError(result, "SECRET_DETECTED", 1);
    assert.equal(result.stdout.includes(SECRET), false);
  });
});

describe("status", () => {
  it("reports remote:false for a notebook without a remote", async () => {
    const sandbox = await newSandbox();
    const result = await cli(sandbox, ["status", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const data = parseEnvelope(result).data;
    assert.equal(data?.repo_ok, true);
    assert.equal(data?.remote_configured, false);
    assert.match(field(data, "head_commit"), /^[0-9a-f]{40}$/);
    assert.equal(data?.last_backup, null);
  });

  it("reports a configured remote as a boolean and never prints its URL", async () => {
    const sandbox = await newSandbox();
    const bare = await makeBareRemote();
    await cli(sandbox, ["init", "--remote", bare, "--json"]);
    const result = await cli(sandbox, ["status", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseEnvelope(result).data?.remote_configured, true);
    assert.equal(result.stdout.includes(bare), false);
  });

  it("uses NOTEBOOK_DIR and then ~/notebook when no --dir is given", async () => {
    const root = await makeTempDir();
    const home = join(root, "home");
    await mkdir(home);
    const fromEnv = join(root, "from-env");
    const env = sandboxEnv(home);
    env.NOTEBOOK_DIR = fromEnv;
    const envResult = await runProcess(BIN, ["--json", "status"], { env });
    assert.equal(parseEnvelope(envResult).data?.dir, fromEnv);

    delete env.NOTEBOOK_DIR;
    const homeResult = await runProcess(BIN, ["--json", "status"], { env });
    assert.equal(parseEnvelope(homeResult).data?.dir, join(home, "notebook"));
  });
});

describe("backup", () => {
  it("pushes unpublished commits once a remote is added", async () => {
    const sandbox = await newSandbox();
    const created = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      draftInput(),
    );
    assert.deepEqual(parseEnvelope(created).backup, {
      status: "pending",
      reason: "no_remote",
    });

    const bare = await makeBareRemote();
    await cli(sandbox, ["init", "--remote", bare, "--json"]);
    const result = await cli(sandbox, ["backup", "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseEnvelope(result).backup, { status: "pushed" });
    assert.equal(
      await git(bare, ["rev-parse", "main"]),
      await git(sandbox.dir, ["rev-parse", "HEAD"]),
    );

    const status = parseEnvelope(await cli(sandbox, ["status", "--json"]));
    assert.equal(status.data?.unpublished_commits, 0);
    const lastBackup = status.data?.last_backup as
      | Record<string, unknown>
      | null
      | undefined;
    assert.equal(lastBackup?.status, "pushed");
  });

  it("reports a successful create with a configured remote as pushed", async () => {
    const sandbox = await newSandbox();
    const bare = await makeBareRemote();
    await cli(sandbox, ["init", "--remote", bare, "--json"]);
    const result = await cli(sandbox, ["create", "--input", "-"], draftInput());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Backup: pushed/);
  });
});

describe("secret detection", () => {
  it("blocks a secret in the body without echoing it", async () => {
    const sandbox = await newSandbox();
    const json = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      draftInput({ body: SECRET_BODY }),
    );
    const envelope = await expectError(json, "SECRET_DETECTED", 1);
    const findings = envelope.error?.details?.findings as Array<
      Record<string, unknown>
    >;
    assert.equal(findings[0]?.location, "body:line 1");
    assert.equal(json.stdout.includes(SECRET), false);
    assert.equal(json.stderr.includes(SECRET), false);

    const human = await cli(
      sandbox,
      ["create", "--input", "-"],
      draftInput({ body: SECRET_BODY }),
    );
    assert.equal(human.code, 1);
    assert.match(human.stderr, /SECRET_DETECTED/);
    assert.equal(human.stdout.includes(SECRET), false);
    assert.equal(human.stderr.includes(SECRET), false);
    assert.deepEqual(await entryFiles(sandbox), []);
  });

  it("never echoes a secret from invalid JSON", async () => {
    const sandbox = await newSandbox();
    const result = await cli(
      sandbox,
      ["create", "--input", "-", "--json"],
      `{"body": "${SECRET}"`,
    );
    await expectError(result, "VALIDATION_FAILED", 1);
    assert.equal(result.stdout.includes(SECRET), false);
    assert.equal(result.stderr.includes(SECRET), false);
  });
});

describe("usage errors", () => {
  it("exits 2 for unknown and removed commands", async () => {
    const sandbox = await newSandbox();
    for (const command of ["frobnicate", "delete"]) {
      const result = await cli(sandbox, [command, "--json"]);
      await expectError(result, "USAGE", 2);
    }
    const human = await cli(sandbox, ["delete"]);
    assert.equal(human.code, 2);
    assert.match(human.stderr, /unknown command/);
  });

  it("exits 2 for missing arguments and options that do not apply", async () => {
    const sandbox = await newSandbox();
    await expectError(await cli(sandbox, ["read", "--json"]), "USAGE", 2);
    await expectError(await cli(sandbox, ["create", "--json"]), "USAGE", 2);
    await expectError(
      await cli(sandbox, ["read", "x", "--input", "-", "--json"]),
      "USAGE",
      2,
    );
    await expectError(await cli(sandbox, ["--json"]), "USAGE", 2);
  });

  it("prints help on stdout and exits 0", async () => {
    const sandbox = await newSandbox();
    const result = await cli(sandbox, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: notebook/);
  });
});

describe("launcher", () => {
  it("runs through a symlink to bin/notebook", async () => {
    const sandbox = await newSandbox();
    const link = join(await makeTempDir(), "notebook-link");
    await symlink(BIN, link);
    const result = await runProcess(
      link,
      ["--dir", sandbox.dir, "--json", "status"],
      { env: sandboxEnv(sandbox.home) },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(parseEnvelope(result).ok, true);
  });

  it("fails with a clear message when node is missing", async () => {
    const root = await makeTempDir();
    const env = sandboxEnv(join(root, "home"));
    env.PATH = "";
    const result = await runProcess(BIN, ["--json", "status"], { env });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /node \(version 24 or newer\) is required/);
  });
});
