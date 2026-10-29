import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { NotebookError } from "../errors.ts";
import {
  assertSafePath,
  attachmentFilePath,
  isValidId,
  lstatOrNull,
} from "../paths.ts";
import { sha256Hex } from "../revision.ts";
import { type Entry, normalizeText, STATUSES, type Status } from "../schema.ts";
import { type SearchResult, searchEntries } from "../search.ts";
import { listEntries, readEntry } from "../store.ts";
import { renderMarkdown } from "./render.ts";
import {
  type Count,
  countPage,
  entryPage,
  errorPage,
  layout,
  listPage,
  notFoundPage,
  type SearchForm,
  searchPage,
} from "./templates.ts";

export const API_VERSION = 1;
const LIST_LIMIT = 50;
const PAGE_LIMIT = 200;
const RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const STYLE_FILE = fileURLToPath(new URL("./style.css", import.meta.url));
const HTML = "text/html; charset=utf-8";
const CSS = "text/css; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const OCTET = "application/octet-stream";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
};

const ENTRY_ROUTE = /^\/entries\/([^/]+)$/;
const ATTACHMENT_ROUTE = /^\/attachments\/([^/]+)\/([^/]+)$/;
const PROJECT_ROUTE = /^\/projects\/([^/]+)$/;
const TOPIC_ROUTE = /^\/topics\/([^/]+)$/;

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

interface Reply {
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
  const path = url.pathname;
  if (path === "/_health") {
    return json({
      app: "notebook",
      api_version: API_VERSION,
      fingerprint: context.fingerprint,
    });
  }
  if (path === "/static/style.css") {
    return { status: 200, type: CSS, body: await readFile(STYLE_FILE) };
  }
  if (path === "/") return page(await homePage(context.root));
  if (path === "/search") return page(await searchView(context.root, url));
  if (path === "/projects") return page(await projectIndex(context.root));
  if (path === "/topics") return page(await topicIndex(context.root));

  const project = PROJECT_ROUTE.exec(path);
  if (project)
    return page(await projectPage(context.root, decodeName(project[1])));
  const topic = TOPIC_ROUTE.exec(path);
  if (topic) return page(await topicPage(context.root, decodeName(topic[1])));
  const entry = ENTRY_ROUTE.exec(path);
  if (entry) return page(await entryView(context.root, entry[1]));
  const attachment = ATTACHMENT_ROUTE.exec(path);
  if (attachment) {
    return attachmentReply(context.root, attachment[1], attachment[2]);
  }
  return notFound();
}

async function homePage(root: string): Promise<string> {
  const result = await searchLive(root, { limit: LIST_LIMIT });
  return layout("Recent", listPage("Recent", result));
}

async function projectIndex(root: string): Promise<string> {
  const entries = await liveEntries(root);
  const counts = countBy(entries.map((entry) => entry.project));
  return layout("Projects", countPage("Projects", "/projects/", counts));
}

async function topicIndex(root: string): Promise<string> {
  const entries = await liveEntries(root);
  const counts = countBy(entries.flatMap((entry) => entry.topics));
  return layout("Topics", countPage("Topics", "/topics/", counts));
}

async function projectPage(root: string, name: string): Promise<string> {
  const result = await searchLive(root, { project: name, limit: PAGE_LIMIT });
  return layout(name, listPage(`Project: ${name}`, result));
}

async function topicPage(root: string, name: string): Promise<string> {
  const result = await searchLive(root, { topic: name, limit: PAGE_LIMIT });
  return layout(name, listPage(`Topic: ${name}`, result));
}

async function searchView(root: string, url: URL): Promise<string> {
  const params = url.searchParams;
  const form: SearchForm = {
    q: field(params, "q"),
    project: field(params, "project"),
    topic: field(params, "topic"),
    type: field(params, "type"),
    status: field(params, "status"),
    includeArchived: params.get("include_archived") === "1",
  };
  const status = (STATUSES as readonly string[]).includes(form.status)
    ? (form.status as Status)
    : undefined;
  const result = await searchLive(root, {
    query: optional(form.q),
    project: optional(form.project),
    topic: optional(form.topic),
    type: optional(form.type),
    status,
    includeArchived: form.includeArchived,
    limit: PAGE_LIMIT,
  });
  return layout("Search", searchPage(form, result));
}

async function entryView(root: string, id: string): Promise<string> {
  if (!isValidId(id)) throw notFoundError();
  const loaded = await readEntry(root, id);
  const attachmentIds = new Set(
    loaded.entry.attachments.map((attachment) => attachment.id),
  );
  const bodyHtml = renderMarkdown(loaded.body, {
    entryId: loaded.entry.id,
    attachmentIds,
  });
  return layout(loaded.entry.title, entryPage(loaded, bodyHtml));
}

async function attachmentReply(
  root: string,
  entryId: string,
  attachmentId: string,
): Promise<Reply> {
  if (!isValidId(entryId) || !isValidId(attachmentId)) return notFound();
  const { entry } = await readEntry(root, entryId);
  const attachment = entry.attachments.find(
    (candidate) => candidate.id === attachmentId,
  );
  if (!attachment) return notFound();
  const file = attachmentFilePath(root, entry.id, attachment.stored_as);
  await assertSafePath(root, file);
  const bytes = await readRegularFile(file);
  if (!bytes) return notFound();
  const inline = RASTER_TYPES.has(attachment.media_type);
  return {
    status: 200,
    type: inline ? attachment.media_type : OCTET,
    body: bytes,
    headers: {
      "Content-Disposition": contentDisposition(
        inline ? "inline" : "attachment",
        attachment.filename,
      ),
    },
  };
}

async function readRegularFile(path: string): Promise<Buffer | undefined> {
  const info = await lstatOrNull(path);
  if (!info) return undefined;
  if (!info.isFile()) {
    throw new NotebookError("UNSAFE_PATH", "attachment is not a regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new NotebookError(
        "UNSAFE_PATH",
        "attachment is not a regular file",
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function contentDisposition(kind: "inline" | "attachment", filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function liveEntries(root: string): Promise<Entry[]> {
  const { entries } = await listEntries(root);
  return entries
    .map((loaded) => loaded.entry)
    .filter((entry) => entry.status !== "archived");
}

async function searchLive(
  root: string,
  options: Parameters<typeof searchEntries>[1],
): Promise<SearchResult> {
  const { entries } = await listEntries(root);
  return searchEntries(entries, options);
}

function countBy(values: readonly string[]): Count[] {
  const counts = new Map<string, Count>();
  for (const value of values) {
    const key = normalizeText(value);
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { name: value, count: 1 });
  }
  return [...counts.values()].sort((a, b) =>
    compare(normalizeText(a.name), normalizeText(b.name)),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function decodeName(raw: string): string {
  try {
    const name = decodeURIComponent(raw);
    if (name.trim() === "") throw notFoundError();
    return name;
  } catch {
    throw notFoundError();
  }
}

function field(params: URLSearchParams, key: string): string {
  return (params.get(key) ?? "").trim();
}

function optional(value: string): string | undefined {
  return value === "" ? undefined : value;
}

function notFoundError(): NotebookError {
  return new NotebookError("NOT_FOUND", "not found");
}

function page(body: string): Reply {
  return { status: 200, type: HTML, body };
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
