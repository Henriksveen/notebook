export const DEFAULT_PROJECT = "Inbox";
export const SOURCE_KINDS = ["url", "repo", "conversation"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
const MAX_TOPICS = 20;
const MAX_SLUG_LENGTH = 50;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SINGLE_LINE_BAD = /[\p{Cc}\p{Cs}\u2028\u2029]/u;
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

export interface FieldError {
  field: string;
  message: string;
}

export type Validation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: FieldError[] };

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

export interface Metadata {
  title: string;
  summary: string;
  project: string;
  topics: string[];
  sources: Source[];
}
export function validateMetadata(value: unknown): Validation<Metadata> {
  const errors: FieldError[] = [];
  if (!isRecord(value)) return invalidResult("input", "must be a JSON object");
  checkKeys(
    value,
    ["title", "summary", "project", "topics", "sources"],
    errors,
    "",
  );
  const metadata: Metadata = {
    title: checkText(value.title, "title", errors, 200),
    summary: checkText(value.summary, "summary", errors, 500),
    project: checkProject(value.project, "project", errors),
    topics:
      value.topics === undefined
        ? []
        : checkTopics(value.topics, "topics", errors),
    sources:
      value.sources === undefined
        ? []
        : checkList(value.sources, "sources", errors, checkSource),
  };
  return errors.length ? { ok: false, errors } : { ok: true, value: metadata };
}
