import { NotebookError } from "./errors.ts";
import { isValidId } from "./paths.ts";
import { describeErrors, type Source, validateMetadata } from "./schema.ts";

export const TEXT_LIMIT = 2 * 1024 * 1024;
export const META_LIMIT = 64 * 1024;
export const HTML_LIMIT = 20 * 1024 * 1024;
export const JSON_LIMIT = 4 * 1024 * 1024;
export type Entity = "page" | "prompt";
export interface PromptRef {
  id: string;
  revision: string;
}
// Stored source provenance stays readable when a page is edited or restored.
export interface PageOrigin {
  entry: string;
  attachment: string;
  sha256: string;
}
export interface Common {
  schema_version: 2;
  id: string;
  title: string;
  project: string;
  topics: string[];
  created_at: string;
  updated_at: string;
  change_summary: string;
}
export interface PageInput {
  title: string;
  summary: string;
  project: string;
  topics: string[];
  kind: "concept" | "report";
  sources: Source[];
  context?: string;
  prompt?: PromptRef;
}
export interface PromptVariable {
  name: string;
  description: string;
  default?: string;
}
export interface PromptInput {
  title: string;
  description: string;
  project: string;
  topics: string[];
  template: string;
  inputs: PromptVariable[];
  example?: string;
}
export interface Page extends Common {
  entity: "page";
  summary: string;
  kind: "concept" | "report";
  sources: Source[];
  prompt?: PromptRef;
  imported_from?: PageOrigin;
}
export interface Prompt extends Common {
  entity: "prompt";
  description: string;
  template: string;
  inputs: PromptVariable[];
  example?: string;
}
export type Item = Page | Prompt;
const PAGE_FIELDS = [
  "title",
  "summary",
  "project",
  "topics",
  "kind",
  "sources",
  "context",
  "prompt",
];
const PROMPT_FIELDS = [
  "title",
  "description",
  "project",
  "topics",
  "template",
  "inputs",
  "example",
];

export function invalid(message: string): never {
  throw new NotebookError("VALIDATION_FAILED", message);
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("expected an object");
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    invalid("unknown or managed field");
}
export function text(
  value: unknown,
  field: string,
  max: number,
  multiline = false,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    (multiline
      ? Buffer.byteLength(value) > max
      : [...value.trim()].length > max) ||
    (!multiline && /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(value))
  )
    invalid(`${field} is missing, too long, or invalid`);
  return multiline ? value : value.trim();
}
function metadata(raw: Record<string, unknown>, summary: unknown) {
  const result = validateMetadata({
    title: raw.title,
    summary,
    project: raw.project,
    topics: raw.topics,
    sources: raw.sources,
  });
  if (!result.ok) invalid(describeErrors(result.errors));
  return result.value;
}
export function placeholders(template: string): string[] {
  return [
    ...new Set(
      [...template.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}
export function pageInput(value: unknown): PageInput {
  const raw = object(value);
  keys(raw, PAGE_FIELDS);
  const base = metadata(raw, raw.summary);
  if (raw.kind !== "concept" && raw.kind !== "report")
    invalid("kind must be concept or report");
  const page: PageInput = {
    title: base.title,
    summary: base.summary,
    project: base.project,
    topics: base.topics,
    sources: base.sources,
    kind: raw.kind,
  };
  if (raw.context !== undefined)
    page.context = text(raw.context, "context", TEXT_LIMIT, true);
  if (raw.prompt !== undefined) {
    const ref = object(raw.prompt);
    keys(ref, ["id", "revision"]);
    if (
      !isValidId(ref.id) ||
      typeof ref.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.revision)
    )
      invalid("invalid prompt provenance");
    page.prompt = { id: ref.id, revision: ref.revision };
  }
  return page;
}
export function promptInput(value: unknown): PromptInput {
  const raw = object(value);
  keys(raw, PROMPT_FIELDS);
  const base = metadata(raw, raw.description);
  const template = text(raw.template, "template", TEXT_LIMIT, true);
  if (!Array.isArray(raw.inputs) || raw.inputs.length > 50)
    invalid("inputs must contain at most 50 definitions");
  const inputs = raw.inputs.map((value) => {
    const input = object(value);
    keys(input, ["name", "description", "default"]);
    const name = text(input.name, "input name", 80);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) invalid("invalid input name");
    const definition: PromptVariable = {
      name,
      description: text(input.description, "input description", 500),
    };
    if (input.default !== undefined) {
      if (
        typeof input.default !== "string" ||
        Buffer.byteLength(input.default) > TEXT_LIMIT
      )
        invalid("invalid input default");
      definition.default = input.default;
    }
    return definition;
  });
  const names = inputs.map((input) => input.name);
  const tokens = placeholders(template);
  if (
    new Set(names).size !== names.length ||
    tokens.length !== names.length ||
    tokens.some((name) => !names.includes(name))
  )
    invalid("input definitions must match template placeholders exactly");
  const prompt: PromptInput = {
    title: base.title,
    description: base.summary,
    project: base.project,
    topics: base.topics,
    template,
    inputs,
  };
  if (raw.example !== undefined)
    prompt.example = text(raw.example, "example", TEXT_LIMIT, true);
  return prompt;
}
export function patchInput(
  entity: Entity,
  value: unknown,
): Record<string, unknown> {
  const raw = object(value);
  keys(raw, [
    ...(entity === "page" ? PAGE_FIELDS : PROMPT_FIELDS),
    "change_summary",
  ]);
  text(raw.change_summary, "change_summary", 500);
  return raw;
}
export function validateItem(value: unknown): Item {
  const raw = object(value);
  const common = [
    "schema_version",
    "id",
    "entity",
    "archived",
    "created_at",
    "updated_at",
    "change_summary",
  ];
  if (raw.entity !== "page" && raw.entity !== "prompt")
    invalid("invalid library entity");
  keys(raw, [
    ...common,
    ...(raw.entity === "page"
      ? PAGE_FIELDS.filter((key) => key !== "context")
      : PROMPT_FIELDS),
    ...(raw.entity === "page" ? ["imported_from"] : []),
  ]);
  if (
    raw.schema_version !== 2 ||
    !isValidId(raw.id) ||
    (raw.archived !== undefined && typeof raw.archived !== "boolean")
  )
    invalid("invalid library metadata");
  // Records saved before archiving was removed carry a legacy flag; drop it.
  delete raw.archived;
  for (const field of ["created_at", "updated_at"]) {
    if (
      typeof raw[field] !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw[field]) ||
      !Number.isFinite(Date.parse(raw[field])) ||
      new Date(raw[field]).toISOString() !== raw[field]
    )
      invalid("invalid timestamp");
  }
  text(raw.change_summary, "change_summary", 500);
  const fields = raw.entity === "page" ? PAGE_FIELDS : PROMPT_FIELDS;
  const input = Object.fromEntries(
    fields
      .filter((key) => raw[key] !== undefined)
      .map((key) => [key, raw[key]]),
  );
  if (raw.entity === "page") pageInput(input);
  else promptInput(input);
  if (raw.imported_from !== undefined) {
    const ref = object(raw.imported_from);
    keys(ref, ["entry", "attachment", "sha256"]);
    if (
      !isValidId(ref.entry) ||
      !isValidId(ref.attachment) ||
      typeof ref.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(ref.sha256)
    )
      invalid("invalid import provenance");
  }
  return raw as unknown as Item;
}
