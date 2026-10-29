import { NotebookError } from "./errors.ts";

export const DEFAULT_PORT = 43127;

export function resolvePort(
  options: { flag?: string; env?: Record<string, string | undefined> } = {},
): number {
  const raw = options.flag || (options.env ?? process.env).NOTEBOOK_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new NotebookError(
      "USAGE",
      "port must be an integer between 1 and 65535",
    );
  }
  return port;
}

export function entryUrl(id: string, port: number = DEFAULT_PORT): string {
  return `http://127.0.0.1:${port}/entries/${id}`;
}
