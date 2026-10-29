import { type ChildProcess, spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryUrl, homeUrl } from "../config.ts";
import { NotebookError } from "../errors.ts";
import { runtimeDir, withLock } from "../lock.ts";
import { assertSafePath } from "../paths.ts";
import { fingerprintOf } from "./server.ts";

const PROBE_TIMEOUT_MS = 1000;
const START_TIMEOUT_MS = 5000;
const POLL_MS = 100;
const MAX_HEALTH_BYTES = 4096;
const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const LOG_NAME = "server.log";

export interface OpenOptions {
  dir: string;
  port: number;
  entryId?: string;
  noBrowser?: boolean;
  opener?: (url: string) => Promise<void>;
}

export interface OpenResult {
  url: string;
  reused: boolean;
  pid?: number;
  warnings: string[];
}

type Probe =
  | { state: "none" }
  | { state: "notebook"; fingerprint: string }
  | { state: "other" };

export async function openNotebook(options: OpenOptions): Promise<OpenResult> {
  const fingerprint = await fingerprintOf(options.dir);
  const url = options.entryId
    ? entryUrl(options.entryId, options.port)
    : homeUrl(options.port);
  const warnings: string[] = [];
  let outcome: { reused: boolean; pid?: number };
  if ((await inspect(options.port, fingerprint)) === "match") {
    outcome = { reused: true };
  } else {
    outcome = await withLock(options.dir, "open.lock", async () => {
      if ((await inspect(options.port, fingerprint)) === "match") {
        return { reused: true };
      }
      const pid = await startServer(options.dir, options.port, fingerprint);
      return { reused: false, pid };
    });
  }
  if (!options.noBrowser) {
    try {
      await (options.opener ?? openInBrowser)(url);
    } catch {
      warnings.push(`could not open a browser; open ${url} manually`);
    }
  }
  return { url, ...outcome, warnings };
}

async function inspect(
  port: number,
  fingerprint: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<"match" | "absent"> {
  const probe = await probeHealth(port, timeoutMs);
  if (probe.state === "none") return "absent";
  if (probe.state === "notebook" && probe.fingerprint === fingerprint) {
    return "match";
  }
  throw portInUse(port);
}

function portInUse(port: number): NotebookError {
  return new NotebookError(
    "PORT_IN_USE",
    `port ${port} is used by another process; choose another with --port`,
  );
}

function probeHealth(port: number, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    const request = httpGet(
      {
        host: "127.0.0.1",
        port,
        path: "/_health",
        headers: { Host: `127.0.0.1:${port}` },
        agent: false,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_HEALTH_BYTES) finish({ state: "other" });
        });
        response.on("end", () => finish(classify(response.statusCode, body)));
        response.on("error", () => finish({ state: "other" }));
      },
    );
    const deadline = setTimeout(() => finish({ state: "other" }), timeoutMs);
    const finish = (probe: Probe) => {
      clearTimeout(deadline);
      request.destroy();
      resolve(probe);
    };
    request.on("error", (error: NodeJS.ErrnoException) => {
      finish(
        error.code === "ECONNREFUSED" ? { state: "none" } : { state: "other" },
      );
    });
  });
}

function classify(status: number | undefined, body: string): Probe {
  try {
    const value: unknown = JSON.parse(body);
    if (
      status === 200 &&
      typeof value === "object" &&
      value !== null &&
      "app" in value &&
      value.app === "notebook" &&
      "api_version" in value &&
      value.api_version === 1 &&
      "fingerprint" in value &&
      typeof value.fingerprint === "string"
    ) {
      return { state: "notebook", fingerprint: value.fingerprint };
    }
  } catch {
    // Not a notebook response; treated as another listener below.
  }
  return { state: "other" };
}

async function startServer(
  dir: string,
  port: number,
  fingerprint: string,
): Promise<number> {
  const logPath = join(runtimeDir(dir), LOG_NAME);
  await assertSafePath(dir, logPath);
  const log = await openFile(logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [CLI, "serve", "--dir", dir, "--port", String(port)],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
  } finally {
    await log.close();
  }
  child.on("error", () => undefined);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  try {
    await waitForServer(port, fingerprint, () => exited, logPath);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  child.unref();
  if (child.pid === undefined) {
    throw new NotebookError("INTERNAL", "could not start the notebook website");
  }
  return child.pid;
}

async function waitForServer(
  port: number,
  fingerprint: string,
  exited: () => boolean,
  logPath: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const probeMs = Math.min(PROBE_TIMEOUT_MS, remaining);
    if ((await inspect(port, fingerprint, probeMs)) === "match") return;
    if (exited()) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (exited()) {
    if ((await probeHealth(port, PROBE_TIMEOUT_MS)).state === "other") {
      throw portInUse(port);
    }
  }
  throw new NotebookError(
    "INTERNAL",
    `the notebook website did not start; check ${logPath}`,
  );
}

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("xdg-open", [url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
