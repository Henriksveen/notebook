import { parseArgs } from "node:util";
import { NotebookError } from "./errors.ts";

export const COMMANDS = [
  "init",
  "create",
  "validate",
  "search",
  "read",
  "update",
  "ready",
  "archive",
  "restore",
  "attach",
  "status",
  "backup",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export interface Values {
  dir?: string;
  json?: boolean;
  help?: boolean;
  port?: string;
  remote?: string;
  input?: string;
  "expected-revision"?: string;
  file?: string;
  name?: string;
  project?: string;
  topic?: string;
  type?: string;
  status?: string;
  "include-archived"?: boolean;
  limit?: string;
  offset?: string;
}

type OptionName = keyof Values;

const OPTIONS = {
  dir: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  port: { type: "string" },
  remote: { type: "string" },
  input: { type: "string" },
  "expected-revision": { type: "string" },
  file: { type: "string" },
  name: { type: "string" },
  project: { type: "string" },
  topic: { type: "string" },
  type: { type: "string" },
  status: { type: "string" },
  "include-archived": { type: "boolean" },
  limit: { type: "string" },
  offset: { type: "string" },
} as const;

const GLOBAL_OPTIONS: OptionName[] = ["dir", "json", "help", "port"];

type PositionalRule = "none" | "id" | "optional-id" | "query";

interface CommandSpec {
  positionals: PositionalRule;
  options: OptionName[];
}

const REVISION: OptionName[] = ["expected-revision"];

const COMMAND_SPECS: Record<CommandName, CommandSpec> = {
  init: { positionals: "none", options: ["remote"] },
  create: { positionals: "none", options: ["input"] },
  validate: { positionals: "optional-id", options: ["input"] },
  search: {
    positionals: "query",
    options: [
      "project",
      "topic",
      "type",
      "status",
      "include-archived",
      "limit",
      "offset",
    ],
  },
  read: { positionals: "id", options: [] },
  update: { positionals: "id", options: [...REVISION, "input"] },
  ready: { positionals: "id", options: REVISION },
  archive: { positionals: "id", options: REVISION },
  restore: { positionals: "id", options: REVISION },
  attach: {
    positionals: "id",
    options: [...REVISION, "file", "name"],
  },
  status: { positionals: "none", options: [] },
  backup: { positionals: "none", options: [] },
};

export type Invocation =
  | { kind: "help" }
  | {
      kind: "run";
      command: CommandName;
      positionals: string[];
      values: Values;
    };

export function usage(message: string): NotebookError {
  return new NotebookError("USAGE", message);
}

export function parseInvocation(argv: string[]): Invocation {
  const parsed = parseOptions(argv);
  const values = parsed.values as Values;
  if (values.help) return { kind: "help" };
  const [name, ...positionals] = parsed.positionals;
  if (name === undefined) throw usage("missing command");
  if (!isCommand(name)) throw usage(`unknown command: ${sanitize(name)}`);
  checkOptions(name, values);
  checkPositionals(name, positionals);
  return { kind: "run", command: name, positionals, values };
}

function parseOptions(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw usage(describeParseError(error));
  }
}

function describeParseError(error: unknown): string {
  const code = error instanceof Error && "code" in error ? error.code : "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const match =
      error instanceof Error ? /'(-[^'=]*)/.exec(error.message) : null;
    const name = match ? sanitize(match[1] ?? "") : "";
    return name ? `unknown option: ${name}` : "unknown option";
  }
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return "option value is missing or invalid";
  }
  return "invalid arguments";
}

function sanitize(value: string): string {
  return /^-{0,2}[A-Za-z][A-Za-z0-9-]*$/.test(value) ? value : "(invalid)";
}

function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

function checkOptions(command: CommandName, values: Values): void {
  const allowed = [...GLOBAL_OPTIONS, ...COMMAND_SPECS[command].options];
  for (const key of Object.keys(values) as OptionName[]) {
    if (values[key] !== undefined && !allowed.includes(key)) {
      throw usage(`--${key} is not valid for ${command}`);
    }
  }
}

function checkPositionals(command: CommandName, positionals: string[]): void {
  const count = positionals.length;
  switch (COMMAND_SPECS[command].positionals) {
    case "none":
      if (count > 0) throw usage(`${command} takes no positional arguments`);
      return;
    case "id":
      if (count !== 1) throw usage(`${command} requires exactly one ID`);
      return;
    case "optional-id":
      if (count > 1) throw usage(`${command} takes at most one ID`);
      return;
    case "query":
      return;
  }
}
