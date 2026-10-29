import { isValidId } from "./paths.ts";

export const SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT = "Inbox";
export const STATUSES = ["draft", "ready", "archived"] as const;
export const ARCHIVED_FROM = ["draft", "ready"] as const;
export const SOURCE_KINDS = ["url", "repo", "conversation"] as const;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const MAX_TOPICS = 20;
const MAX_SLUG_LENGTH = 50;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE_LINE_BAD = /[\p{Cc}\p{Cs}\u2028\u2029]/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION = /^[a-z0-9]{1,16}$/;

export type Status = (typeof STATUSES)[number];
export type ArchivedFrom = (typeof ARCHIVED_FROM)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface UrlSource {
  kind: "url";
  url: string;
  title?: string;
}

export interface RepoSource {
  kind: "repo";
  repo: string;
  commit?: string;
  path?: string;
  title?: string;
}

export interface ConversationSource {
  kind: "conversation";
  ref: string;
  title?: string;
}

export type Source = UrlSource | RepoSource | ConversationSource;

export interface Attachment {
  id: string;
  filename: string;
  stored_as: string;
  media_type: string;
  size: number;
  sha256: string;
}

export interface Entry {
  schema_version: 1;
  id: string;
  title: string;
  summary: string;
  project: string;
  topics: string[];
  type: string;
  created_at: string;
  updated_at: string;
  status: Status;
  archived_from?: ArchivedFrom;
  sources: Source[];
  attachments: Attachment[];
}

export interface EntryInput {
  title: string;
  summary: string;
  project: string;
  topics: string[];
  type: string;
  body: string;
  sources: Source[];
}

export type EntryPatch = Partial<EntryInput>;

export interface FieldError {
  field: string;
  message: string;
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

const ENTRY_KEYS = [
  "schema_version",
  "id",
  "title",
  "summary",
  "project",
  "topics",
  "type",
  "created_at",
  "updated_at",
  "status",
  "archived_from",
  "sources",
  "attachments",
];
const INPUT_KEYS = [
  "title",
  "summary",
  "project",
  "topics",
  "type",
  "body",
  "sources",
];
const PATCH_KEYS = INPUT_KEYS;
const ATTACHMENT_KEYS = [
  "id",
  "filename",
  "stored_as",
  "media_type",
  "size",
  "sha256",
];

const SOURCE_FIELDS: Record<
  SourceKind,
  { required: Record<string, number>; optional: Record<string, number> }
> = {
  url: { required: { url: 2048 }, optional: { title: 200 } },
  repo: {
    required: { repo: 300 },
    optional: { commit: 100, path: 500, title: 200 },
  },
  conversation: { required: { ref: 300 }, optional: { title: 200 } },
};

export function invalidResult(
  field: string,
  message: string,
): { ok: false; errors: FieldError[] } {
  return { ok: false, errors: [{ field, message }] };
}

export function describeErrors(errors: FieldError[]): string {
  return errors.map((error) => `${error.field} ${error.message}`).join("; ");
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

export function normalizeSlug(value: string): string | undefined {
  const slug = value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length <= MAX_SLUG_LENGTH && SLUG.test(slug) ? slug : undefined;
}

export function validateEntry(value: unknown): Validation<Entry> {
  const errors: FieldError[] = [];
  if (!isRecord(value)) return invalidResult("entry", "must be a mapping");
  checkKeys(value, ENTRY_KEYS, errors, "");
  if (value.schema_version !== SCHEMA_VERSION)
    addError(errors, "schema_version", "must be 1");
  const status = checkEnum(value.status, STATUSES, "status", errors);
  const archivedFrom =
    value.archived_from === undefined
      ? undefined
      : checkEnum(value.archived_from, ARCHIVED_FROM, "archived_from", errors);
  if (status === "archived" && archivedFrom === undefined) {
    addError(errors, "archived_from", "is required when status is archived");
  }
  if (status !== "archived" && value.archived_from !== undefined) {
    addError(
      errors,
      "archived_from",
      "is only allowed when status is archived",
    );
  }
  const entry: Entry = {
    schema_version: SCHEMA_VERSION,
    id: checkId(value.id, "id", errors),
    title: checkText(value.title, "title", errors, 200),
    summary: checkText(value.summary, "summary", errors, 500),
    project: checkProject(value.project, "project", errors),
    topics: checkTopics(value.topics, "topics", errors),
    type: checkSlug(value.type, "type", errors),
    created_at: checkTimestamp(value.created_at, "created_at", errors),
    updated_at: checkTimestamp(value.updated_at, "updated_at", errors),
    status,
    sources: checkList(value.sources, "sources", errors, checkSource),
    attachments: checkList(
      value.attachments,
      "attachments",
      errors,
      checkAttachment,
    ),
  };
  if (archivedFrom !== undefined) entry.archived_from = archivedFrom;
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: entry };
}

export function validateEntryInput(value: unknown): Validation<EntryInput> {
  const errors: FieldError[] = [];
  if (!isRecord(value)) return invalidResult("input", "must be a JSON object");
  checkKeys(value, INPUT_KEYS, errors, "");
  const input: EntryInput = {
    title: checkText(value.title, "title", errors, 200),
    summary: checkText(value.summary, "summary", errors, 500),
    project: checkProject(value.project, "project", errors),
    topics:
      value.topics === undefined
        ? []
        : checkTopics(value.topics, "topics", errors),
    type: checkSlug(value.type, "type", errors),
    body: checkBody(value.body, errors),
    sources:
      value.sources === undefined
        ? []
        : checkList(value.sources, "sources", errors, checkSource),
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: input };
}

export function validateEntryPatch(value: unknown): Validation<EntryPatch> {
  const errors: FieldError[] = [];
  if (!isRecord(value)) return invalidResult("patch", "must be a JSON object");
  checkKeys(value, PATCH_KEYS, errors, "");
  if (Object.keys(value).length === 0)
    addError(errors, "patch", "must set at least one field");
  const patch: EntryPatch = {};
  if (value.title !== undefined)
    patch.title = checkText(value.title, "title", errors, 200);
  if (value.summary !== undefined)
    patch.summary = checkText(value.summary, "summary", errors, 500);
  if (value.project !== undefined)
    patch.project = checkProject(value.project, "project", errors);
  if (value.topics !== undefined)
    patch.topics = checkTopics(value.topics, "topics", errors);
  if (value.type !== undefined)
    patch.type = checkSlug(value.type, "type", errors);
  if (value.body !== undefined) patch.body = checkBody(value.body, errors);
  if (value.sources !== undefined)
    patch.sources = checkList(value.sources, "sources", errors, checkSource);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: patch };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(errors: FieldError[], field: string, message: string): void {
  errors.push({ field, message });
}

function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errors: FieldError[],
  prefix: string,
): void {
  for (const [index, key] of Object.keys(value).entries()) {
    if (!allowed.includes(key))
      addError(
        errors,
        `${prefix}<unknown field #${index + 1}>`,
        "is not a known field",
      );
  }
}

function expectString(
  value: unknown,
  field: string,
  errors: FieldError[],
): string | undefined {
  if (typeof value === "string") return value;
  addError(
    errors,
    field,
    value === undefined ? "is required" : "must be a string",
  );
  return undefined;
}

function checkText(
  value: unknown,
  field: string,
  errors: FieldError[],
  max: number,
): string {
  const text = expectString(value, field, errors);
  if (text === undefined) return "";
  const trimmed = text.trim();
  if (trimmed === "") {
    addError(errors, field, "must not be empty");
    return "";
  }
  if ([...trimmed].length > max) {
    addError(errors, field, `must be at most ${max} characters`);
    return "";
  }
  if (SINGLE_LINE_BAD.test(trimmed)) {
    addError(errors, field, "must be a single line");
    return "";
  }
  return trimmed;
}

function checkBody(value: unknown, errors: FieldError[]): string {
  const body = expectString(value, "body", errors);
  if (body === undefined) return "";
  if (body.trim() === "") addError(errors, "body", "must not be empty");
  return body;
}

function checkSlug(
  value: unknown,
  field: string,
  errors: FieldError[],
): string {
  const text = expectString(value, field, errors);
  if (text === undefined) return "";
  const slug = normalizeSlug(text);
  if (slug === undefined) {
    addError(
      errors,
      field,
      "must be a lowercase slug (a-z, 0-9, single hyphens), at most 50 characters",
    );
    return "";
  }
  return slug;
}

function checkTopics(
  value: unknown,
  field: string,
  errors: FieldError[],
): string[] {
  const topics = checkList(value, field, errors, checkSlug);
  if (topics.length > MAX_TOPICS)
    addError(errors, field, `must have at most ${MAX_TOPICS} topics`);
  return [...new Set(topics)].sort();
}

function checkProject(
  value: unknown,
  field: string,
  errors: FieldError[],
): string {
  if (value === undefined || value === null) return DEFAULT_PROJECT;
  if (typeof value === "string" && value.trim() === "") return DEFAULT_PROJECT;
  return checkText(value, field, errors, 80);
}

function checkId(value: unknown, field: string, errors: FieldError[]): string {
  const id = expectString(value, field, errors);
  if (id === undefined) return "";
  if (!isValidId(id)) {
    addError(errors, field, "must be a UUID v4");
    return "";
  }
  return id;
}

function checkTimestamp(
  value: unknown,
  field: string,
  errors: FieldError[],
): string {
  const text = expectString(value, field, errors);
  if (text === undefined) return "";
  const date = new Date(text);
  if (
    !TIMESTAMP.test(text) ||
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== text
  ) {
    addError(
      errors,
      field,
      "must be an ISO-8601 UTC timestamp like 2026-10-29T12:00:00.000Z",
    );
    return "";
  }
  return text;
}

function checkEnum<T extends string>(
  value: unknown,
  options: readonly T[],
  field: string,
  errors: FieldError[],
): T {
  const text = expectString(value, field, errors);
  if (text !== undefined && (options as readonly string[]).includes(text))
    return text as T;
  if (text !== undefined)
    addError(errors, field, `must be one of ${options.join(", ")}`);
  return options[0];
}

function checkMatch(
  value: unknown,
  pattern: RegExp,
  field: string,
  message: string,
  errors: FieldError[],
): string {
  const text = expectString(value, field, errors);
  if (text === undefined) return "";
  if (!pattern.test(text)) {
    addError(errors, field, message);
    return "";
  }
  return text;
}

function checkList<T>(
  value: unknown,
  field: string,
  errors: FieldError[],
  check: (item: unknown, field: string, errors: FieldError[]) => T | undefined,
): T[] {
  if (value === undefined) {
    addError(errors, field, "is required");
    return [];
  }
  if (!Array.isArray(value)) {
    addError(errors, field, "must be an array");
    return [];
  }
  return value.flatMap((item, index) => {
    const checked = check(item, `${field}[${index}]`, errors);
    return checked === undefined ? [] : [checked];
  });
}

function checkHttpUrl(
  value: unknown,
  field: string,
  errors: FieldError[],
): string {
  const text = checkText(value, field, errors, 2048);
  if (text === "") return "";
  if (isHttpUrl(text)) return text;
  addError(errors, field, "must be an http or https URL");
  return "";
}

function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function checkSource(
  value: unknown,
  field: string,
  errors: FieldError[],
): Source | undefined {
  if (!isRecord(value)) {
    addError(errors, field, "must be an object");
    return undefined;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !Object.hasOwn(SOURCE_FIELDS, kind)) {
    addError(errors, `${field}.kind`, "must be one of url, repo, conversation");
    return undefined;
  }
  const shape = SOURCE_FIELDS[kind as SourceKind];
  const before = errors.length;
  checkKeys(
    value,
    ["kind", ...Object.keys(shape.required), ...Object.keys(shape.optional)],
    errors,
    `${field}.`,
  );
  const source: Record<string, string> = { kind };
  for (const [key, max] of Object.entries(shape.required)) {
    const raw =
      key === "url"
        ? checkHttpUrl(value[key], `${field}.${key}`, errors)
        : checkText(value[key], `${field}.${key}`, errors, max);
    source[key] = raw;
  }
  for (const [key, max] of Object.entries(shape.optional)) {
    if (value[key] === undefined) continue;
    source[key] = checkText(value[key], `${field}.${key}`, errors, max);
  }
  return errors.length === before ? (source as unknown as Source) : undefined;
}

function checkAttachment(
  value: unknown,
  field: string,
  errors: FieldError[],
): Attachment | undefined {
  if (!isRecord(value)) {
    addError(errors, field, "must be an object");
    return undefined;
  }
  const before = errors.length;
  checkKeys(value, ATTACHMENT_KEYS, errors, `${field}.`);
  const id = checkId(value.id, `${field}.id`, errors);
  const filename = checkText(value.filename, `${field}.filename`, errors, 255);
  if (/[\\/]/.test(filename) || filename === "." || filename === "..") {
    addError(errors, `${field}.filename`, "must be a file basename");
  }
  const storedAs = checkText(
    value.stored_as,
    `${field}.stored_as`,
    errors,
    100,
  );
  if (
    !storedAs.startsWith(`${id}.`) ||
    !EXTENSION.test(storedAs.slice(id.length + 1))
  ) {
    addError(errors, `${field}.stored_as`, "must be <attachment-id>.<ext>");
  }
  const mediaType = checkMatch(
    value.media_type,
    MEDIA_TYPE,
    `${field}.media_type`,
    "must be a media type like image/png",
    errors,
  );
  const size = value.size;
  if (!isSize(size))
    addError(
      errors,
      `${field}.size`,
      "must be an integer between 0 and 20 MiB",
    );
  const sha256 = checkMatch(
    value.sha256,
    SHA256,
    `${field}.sha256`,
    "must be 64 lowercase hex characters",
    errors,
  );
  if (errors.length !== before) return undefined;
  return {
    id,
    filename,
    stored_as: storedAs,
    media_type: mediaType,
    size: isSize(size) ? size : 0,
    sha256,
  };
}

function isSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_ATTACHMENT_BYTES
  );
}
