import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createItem } from "../src/library.ts";
import {
  cleanupTempDirs,
  freePort,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/notebook", import.meta.url));
const MISSING = "00000000-0000-4000-8000-000000000999";

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const servers: { dir: string; port: number }[] = [];

after(async () => {
  for (const server of servers.splice(0)) {
    for (const pid of await servingPids(server.dir, server.port)) {
      process.kill(pid, "SIGTERM");
    }
  }
  await cleanupTempDirs();
});

async function servingPids(dir: string, port: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", [
      "-f",
      `src/cli.ts serve --dir ${dir} --port ${port}`,
    ]);
    return stdout
      .split("\n")
      .filter((line) => line !== "")
      .map(Number);
  } catch {
    return [];
  }
}

async function sandboxEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await makeTempDir();
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

function run(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });
}

function envelope(result: Result): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("open and serve commands", () => {
  it("serve refuses a directory that is not a notebook", async () => {
    const dir = await makeTempDir();
    const result = await run(
      ["--dir", dir, "--json", "serve", "--port", String(await freePort())],
      await sandboxEnv(),
    );
    assert.equal(result.code, 1);
    assert.equal(envelope(result).ok, false);
    assert.equal(
      (envelope(result).error as { code: string }).code,
      "NOT_A_NOTEBOOK",
    );
  });

  it("open refuses a directory that is not a notebook", async () => {
    const result = await run(
      ["--dir", await makeTempDir(), "--json", "open", "--no-browser"],
      await sandboxEnv(),
    );
    assert.equal(result.code, 1);
    assert.equal(
      (envelope(result).error as { code: string }).code,
      "NOT_A_NOTEBOOK",
    );
  });

  it("page open validates its ID", async () => {
    const dir = await newNotebook();
    const env = await sandboxEnv();
    const invalid = await run(
      ["--dir", dir, "--json", "page", "open", "not-an-id", "--no-browser"],
      env,
    );
    assert.equal(invalid.code, 2);
    assert.equal((envelope(invalid).error as { code: string }).code, "USAGE");
    const missing = await run(
      ["--dir", dir, "--json", "page", "open", MISSING, "--no-browser"],
      env,
    );
    assert.equal(missing.code, 1);
    assert.equal(
      (envelope(missing).error as { code: string }).code,
      "NOT_FOUND",
    );
  });

  it("open starts the website, then reuses it, and links to pages", async () => {
    const dir = await newNotebook();
    const page = await createItem(
      dir,
      "page",
      { title: "Page", summary: "A page", kind: "concept" },
      "<p>Hello</p>",
    );
    const port = await freePort();
    servers.push({ dir, port });
    const env = await sandboxEnv();
    const first = await run(
      ["--dir", dir, "--json", "--port", String(port), "open", "--no-browser"],
      env,
    );
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(envelope(first).data, {
      url: `http://127.0.0.1:${port}/`,
      reused: false,
    });
    assert.deepEqual(envelope(first).warnings, []);

    const second = await run(
      [
        "--dir",
        dir,
        "--json",
        "--port",
        String(port),
        "page",
        "open",
        page.id,
        "--no-browser",
      ],
      env,
    );
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(envelope(second).data, {
      url: `http://127.0.0.1:${port}/pages/${page.id}`,
      reused: true,
    });
    assert.equal(await servingCount(dir, port), 1);
  });

  it("open text output prints the URL", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    servers.push({ dir, port });
    const result = await run(
      ["--dir", dir, "--port", String(port), "open", "--no-browser"],
      await sandboxEnv(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      `Started the notebook website: http://127.0.0.1:${port}/\n`,
    );
  });

  it("open fails with PORT_IN_USE when a foreign process holds the port", async () => {
    const sockets = new Set<Socket>();
    const foreign = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      foreign.listen(0, "127.0.0.1", resolve),
    );
    const { port } = foreign.address() as AddressInfo;
    try {
      const result = await run(
        [
          "--dir",
          await newNotebook(),
          "--json",
          "--port",
          String(port),
          "open",
          "--no-browser",
        ],
        await sandboxEnv(),
      );
      assert.equal(result.code, 1);
      assert.equal(
        (envelope(result).error as { code: string }).code,
        "PORT_IN_USE",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it("serve runs in the foreground and stops on SIGTERM", async () => {
    const dir = await newNotebook();
    const port = await freePort();
    const child = spawn(BIN, ["--dir", dir, "--port", String(port), "serve"], {
      env: await sandboxEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("close", (code) => resolve(code)),
    );
    try {
      await waitFor(() => stdout.includes("Serving the notebook at"));
      assert.ok(stdout.includes(`http://127.0.0.1:${port}/`));
      const health = await fetch(`http://127.0.0.1:${port}/_health`);
      assert.equal(health.status, 200);
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/_health`));
    } finally {
      child.kill("SIGKILL");
    }
  });
});

async function servingCount(dir: string, port: number): Promise<number> {
  return (await servingPids(dir, port)).length;
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for output");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
