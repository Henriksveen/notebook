import { DEFAULT_PORT, entryUrl } from "./config.ts";
import { NotebookError } from "./errors.ts";
import {
  type Entry,
  normalizeSlug,
  normalizeText,
  type Status,
} from "./schema.ts";
import { type LoadWarning, listEntries } from "./store.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export interface SearchOptions {
  query?: string;
  project?: string;
  topic?: string;
  type?: string;
  status?: Status;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  port?: number;
}

export interface SearchDocument {
  entry: Entry;
  body: string;
}

export interface SearchHit {
  id: string;
  title: string;
  summary: string;
  project: string;
  topics: string[];
  type: string;
  status: Status;
  updated_at: string;
  url: string;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

interface Candidate {
  entry: Entry;
  titleMatches: number;
  summaryMatches: number;
  bodyMatches: number;
}

export function searchEntries(
  documents: readonly SearchDocument[],
  options: SearchOptions = {},
): SearchResult {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new NotebookError(
      "USAGE",
      `limit must be an integer between 1 and ${MAX_LIMIT}`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new NotebookError("USAGE", "offset must be a non-negative integer");
  }
  const terms = normalizeText(options.query ?? "")
    .split(/\s+/)
    .filter((term) => term !== "");
  const candidates: Candidate[] = [];
  for (const { entry, body } of documents) {
    if (!matchesFilters(entry, options)) continue;
    const candidate = match(entry, body, terms);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort(compareCandidates);
  return {
    total: candidates.length,
    hits: candidates
      .slice(offset, offset + limit)
      .map((candidate) => toHit(candidate.entry, options.port ?? DEFAULT_PORT)),
  };
}

export async function searchNotebook(
  dir: string,
  options: SearchOptions = {},
): Promise<SearchResult & { warnings: LoadWarning[] }> {
  const { entries, warnings } = await listEntries(dir);
  return { ...searchEntries(entries, options), warnings };
}

function matchesFilters(entry: Entry, options: SearchOptions): boolean {
  if (
    !options.includeArchived &&
    options.status !== "archived" &&
    entry.status === "archived"
  )
    return false;
  if (options.status !== undefined && entry.status !== options.status)
    return false;
  if (
    options.project !== undefined &&
    normalizeText(entry.project) !== normalizeText(options.project)
  )
    return false;
  if (
    options.topic !== undefined &&
    !entry.topics.includes(normalizeSlug(options.topic) ?? "")
  )
    return false;
  if (options.type !== undefined && entry.type !== normalizeSlug(options.type))
    return false;
  return true;
}

function match(
  entry: Entry,
  body: string,
  terms: string[],
): Candidate | undefined {
  const title = normalizeText(entry.title);
  const summary = normalizeText(entry.summary);
  const text = normalizeText(body);
  for (const term of terms) {
    if (
      !title.includes(term) &&
      !summary.includes(term) &&
      !text.includes(term)
    )
      return undefined;
  }
  const count = (haystack: string) =>
    terms.filter((term) => haystack.includes(term)).length;
  return {
    entry,
    titleMatches: count(title),
    summaryMatches: count(summary),
    bodyMatches: count(text),
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.titleMatches - a.titleMatches ||
    b.summaryMatches - a.summaryMatches ||
    b.bodyMatches - a.bodyMatches ||
    compareStrings(b.entry.updated_at, a.entry.updated_at) ||
    compareStrings(a.entry.id, b.entry.id)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toHit(entry: Entry, port: number): SearchHit {
  return {
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    project: entry.project,
    topics: entry.topics,
    type: entry.type,
    status: entry.status,
    updated_at: entry.updated_at,
    url: entryUrl(entry.id, port),
  };
}
