import { readFile, realpath } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { NotebookError } from "../errors.ts";
import { sha256Hex } from "../revision.ts";
import { libraryRoute } from "./library.ts";
import { SECURITY_HEADERS } from "./security.ts";
import { errorPage, notFoundPage } from "./templates.ts";
export const API_VERSION = 1;
const STYLE_FILE = fileURLToPath(new URL("./style.css", import.meta.url));
const HTML = "text/html; charset=utf-8",
  CSS = "text/css; charset=utf-8",
  JSON_TYPE = "application/json; charset=utf-8",
  TEXT = "text/plain; charset=utf-8";
export interface ServerOptions {
  dir: string;
  port: number;
  host?: "127.0.0.1";
}

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Context {
  root: string;
  fingerprint: string;
  hosts: Set<string>;
}

export interface Reply {
  status: number;
  type: string;
  body: string | Uint8Array;
  headers?: Record<string, string>;
}

export async function fingerprintOf(dir: string): Promise<string> {
  return sha256Hex(await realpath(dir));
}

export async function createServer(options: ServerOptions): Promise<WebServer> {
  const root = await realpath(options.dir);
  const server = createHttpServer();
  await listen(server, options.port);
  const { port } = server.address() as AddressInfo;
  const context: Context = {
    root,
    fingerprint: sha256Hex(root),
    hosts: new Set([`127.0.0.1:${port}`, `localhost:${port}`]),
  };
  server.on("request", (request, response) => {
    respond(context, request, response).catch(() => response.destroy());
  });
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new NotebookError("PORT_IN_USE", `port ${port} is already in use`)
          : error,
      );
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

async function respond(
  context: Context,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const head = request.method === "HEAD";
  try {
    const host = String(request.headers.host ?? "").toLowerCase();
    if (!context.hosts.has(host)) {
      return send(response, text(421, "Misdirected Request"), head);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(
        response,
        { ...text(405, "Method Not Allowed"), headers: { Allow: "GET, HEAD" } },
        false,
      );
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    send(response, await route(context, url), head);
  } catch (error) {
    send(response, failure(error), head);
  }
}

function send(response: ServerResponse, reply: Reply, head: boolean): void {
  const body =
    typeof reply.body === "string" ? Buffer.from(reply.body) : reply.body;
  response.writeHead(reply.status, {
    ...SECURITY_HEADERS,
    "Content-Type": reply.type,
    "Content-Length": String(body.byteLength),
    ...reply.headers,
  });
  response.end(head ? undefined : body);
}

async function route(context: Context, url: URL): Promise<Reply> {
  if (url.pathname === "/_health")
    return json({
      app: "notebook",
      api_version: API_VERSION,
      fingerprint: context.fingerprint,
    });
  if (url.pathname === "/static/style.css")
    return { status: 200, type: CSS, body: await readFile(STYLE_FILE) };
  return (await libraryRoute(context.root, url)) ?? notFound();
}
function notFound(): Reply {
  return { status: 404, type: HTML, body: notFoundPage() };
}

function text(status: number, message: string): Reply {
  return { status, type: TEXT, body: `${message}\n` };
}

function json(value: unknown): Reply {
  return { status: 200, type: JSON_TYPE, body: `${JSON.stringify(value)}\n` };
}

function failure(error: unknown): Reply {
  if (
    error instanceof NotebookError &&
    ["NOT_FOUND", "UNSAFE_PATH", "USAGE"].includes(error.code)
  ) {
    return notFound();
  }
  return { status: 500, type: HTML, body: errorPage() };
}
