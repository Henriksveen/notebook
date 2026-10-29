import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, makeTempDir } from "./fixtures.ts";

after(cleanupTempDirs);

const REPO = fileURLToPath(new URL("..", import.meta.url));
const INSTALL = join(REPO, "scripts", "install.sh");
const BIN = join(REPO, "bin", "notebook");
const SKILL_SRC = join(REPO, "skills", "notebook", "SKILL.md");

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  home: string;
  env: NodeJS.ProcessEnv;
  link: string;
  skill: string;
  notebook: string;
}

async function newSandbox(): Promise<Sandbox> {
  const home = await makeTempDir();
  const gitConfig = join(home, ".gitconfig");
  writeFileSync(gitConfig, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.NOTEBOOK_DIR;
  delete env.NOTEBOOK_PORT;
  delete env.NOTEBOOK_DEBUG;
  return {
    home,
    env,
    link: join(home, ".local", "bin", "notebook"),
    skill: join(home, ".config", "opencode", "skills", "notebook", "SKILL.md"),
    notebook: join(home, "notebook"),
  };
}

function install(args: string[], env: NodeJS.ProcessEnv): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", [INSTALL, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
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
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr }),
    );
  });
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

describe("scripts/install.sh", () => {
  it("prints help and rejects unknown options", async () => {
    const env = (await newSandbox()).env;
    const help = await install(["--help"], env);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--dry-run/);
    const unknown = await install(["--bogus"], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown option/);
  });

  it("--dry-run prints actions and changes nothing", async () => {
    const sandbox = await newSandbox();
    const result = await install(["--dry-run"], sandbox.env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\] would link/);
    assert.match(result.stdout, /\[dry-run\] would copy/);
    assert.match(result.stdout, /\[dry-run\] would run/);
    assert.match(result.stdout, /nothing was changed/);
    assert.equal(exists(join(sandbox.home, ".local")), false);
    assert.equal(exists(join(sandbox.home, ".config")), false);
    assert.equal(exists(sandbox.notebook), false);
  });

  it("installs the link, skill, and notebook, and the launcher works", async () => {
    const sandbox = await newSandbox();
    const result = await install([], sandbox.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(lstatSync(sandbox.link).isSymbolicLink(), true);
    assert.equal(readlinkSync(sandbox.link), BIN);
    assert.equal(
      readFileSync(sandbox.skill, "utf8"),
      readFileSync(SKILL_SRC, "utf8"),
    );
    assert.equal(existsSync(join(sandbox.notebook, ".git")), true);
    assert.match(result.stdout, /next steps/i);
    assert.match(result.stdout, /restart/i);

    const status = await new Promise<Result>((resolve, reject) => {
      execFile(
        sandbox.link,
        ["status", "--json"],
        { env: sandbox.env },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") return reject(error);
          resolve({
            code: typeof error?.code === "number" ? error.code : 0,
            stdout,
            stderr,
          });
        },
      );
    });
    assert.equal(status.code, 0, status.stderr);
    const envelope = JSON.parse(status.stdout) as {
      ok: boolean;
      data: { repo_ok: boolean; remote_configured: boolean };
    };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.repo_ok, true);
    assert.equal(envelope.data.remote_configured, false);
  });

  it("a second run is idempotent", async () => {
    const sandbox = await newSandbox();
    assert.equal((await install([], sandbox.env)).code, 0);
    const head = readFileSync(join(sandbox.notebook, ".git", "HEAD"), "utf8");
    const second = await install([], sandbox.env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /Launcher: already installed/);
    assert.match(second.stdout, /Skill: already installed/);
    assert.match(second.stdout, /already exists; not changed/);
    assert.equal(
      readFileSync(join(sandbox.notebook, ".git", "HEAD"), "utf8"),
      head,
    );
  });

  it("initializes NOTEBOOK_DIR when it is set", async () => {
    const sandbox = await newSandbox();
    const custom = join(sandbox.home, "custom-notebook");
    const result = await install([], { ...sandbox.env, NOTEBOOK_DIR: custom });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(custom, "README.md")), true);
    assert.equal(exists(sandbox.notebook), false);
  });

  it("refuses a different existing skill file and leaves everything untouched", async () => {
    const sandbox = await newSandbox();
    mkdirSync(join(sandbox.skill, ".."), { recursive: true });
    writeFileSync(sandbox.skill, "my own skill\n");
    const result = await install([], sandbox.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /differs from the bundled skill/);
    assert.equal(readFileSync(sandbox.skill, "utf8"), "my own skill\n");
    assert.equal(exists(sandbox.link), false);
    assert.equal(exists(sandbox.notebook), false);
  });

  it("refuses an existing different bin/notebook file", async () => {
    const sandbox = await newSandbox();
    mkdirSync(join(sandbox.home, ".local", "bin"), { recursive: true });
    writeFileSync(sandbox.link, "#!/bin/sh\necho mine\n");
    const result = await install([], sandbox.env);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not point to/);
    assert.equal(readFileSync(sandbox.link, "utf8"), "#!/bin/sh\necho mine\n");
    assert.equal(exists(sandbox.skill), false);
    assert.equal(exists(sandbox.notebook), false);
  });

  it("refuses a link that points somewhere else", async () => {
    const sandbox = await newSandbox();
    const other = join(sandbox.home, "elsewhere");
    writeFileSync(other, "#!/bin/sh\n");
    mkdirSync(join(sandbox.home, ".local", "bin"), { recursive: true });
    symlinkSync(other, sandbox.link);
    const result = await install([], sandbox.env);
    assert.notEqual(result.code, 0);
    assert.equal(readlinkSync(sandbox.link), other);
  });
});
