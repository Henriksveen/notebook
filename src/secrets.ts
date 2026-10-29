import { basename } from "node:path";
import type { Entry } from "./schema.ts";

export interface SecretFinding {
  rule: string;
  location: string;
}

interface Rule {
  id: string;
  lines: (text: string) => number[];
}

interface Hit {
  rule: string;
  line: number;
}

const PLACEHOLDERS = [
  /^<.*>$/,
  /\$\{/,
  /^x{3,}/i,
  /^\*+$/,
  /changeme/i,
  /example/i,
  /^your_/i,
];

const CREDENTIAL_ASSIGNMENT =
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s{0,64}[:=]\s{0,64}["']?([^\s"'`]{8,})/gi;
const URL_SCHEME_WINDOW = 32;
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const WORD_CHAR = /\w/;
const JWT_CHUNK = /[A-Za-z0-9_.-]+/g;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.some((placeholder) => placeholder.test(value));
}

function lineRule(id: string, matches: (line: string) => boolean): Rule {
  return {
    id,
    lines: (text) =>
      text
        .split(/\r?\n/)
        .flatMap((line, index) => (matches(line) ? [index + 1] : [])),
  };
}

function pattern(id: string, regex: RegExp): Rule {
  return lineRule(id, (line) => regex.test(line));
}

function credentialLines(text: string): number[] {
  const offsets: number[] = [];
  for (const match of text.matchAll(CREDENTIAL_ASSIGNMENT)) {
    if (!isPlaceholder(match[1] ?? "")) offsets.push(match.index);
  }
  return lineNumbers(text, offsets);
}

function urlCredentialLines(text: string): number[] {
  const offsets: number[] = [];
  let at = text.indexOf("://");
  while (at !== -1) {
    const scan = scanUrlAuthority(text, at);
    if (scan.found) offsets.push(at);
    at = text.indexOf("://", Math.max(at + 3, scan.stop));
  }
  return lineNumbers(text, offsets);
}

// Scans the authority after "://" up to its first delimiter. An authority never contains
// "/", so it cannot contain another "://"; resuming at `stop` keeps the whole scan linear.
function scanUrlAuthority(
  text: string,
  at: number,
): { found: boolean; stop: number } {
  const start = at + 3;
  if (!hasSchemeBefore(text, at)) return { found: false, stop: start };
  let colon = -1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "@") {
      const found =
        colon > start &&
        index > colon + 1 &&
        !isPlaceholder(text.slice(colon + 1, index)) &&
        isHostStart(text[index + 1]);
      return { found, stop: index };
    }
    if (/[\s/?#]/.test(char)) return { found: false, stop: index };
    if (char === ":" && colon === -1) colon = index;
  }
  return { found: false, stop: text.length };
}

function hasSchemeBefore(text: string, at: number): boolean {
  let start = at;
  while (
    start > 0 &&
    at - start < URL_SCHEME_WINDOW &&
    SCHEME_CHAR.test(text[start - 1] ?? "")
  ) {
    start -= 1;
  }
  return start < at && /[A-Za-z]/.test(text[start] ?? "");
}

function isHostStart(char: string | undefined): boolean {
  return char !== undefined && !/[\s/]/.test(char);
}

function hasJwt(line: string): boolean {
  for (const chunk of line.matchAll(JWT_CHUNK)) {
    const pieces = chunk[0].split(".");
    for (let index = 0; index + 2 < pieces.length; index += 1) {
      if (
        pieces[index + 1] !== "" &&
        pieces[index + 2] !== "" &&
        startsJwtSegment(pieces[index] ?? "")
      ) {
        return true;
      }
    }
  }
  return false;
}

function startsJwtSegment(segment: string): boolean {
  for (
    let at = segment.indexOf("eyJ");
    at !== -1 && at + 3 < segment.length;
    at = segment.indexOf("eyJ", at + 1)
  ) {
    if (at === 0 || !WORD_CHAR.test(segment[at - 1] ?? "")) return true;
  }
  return false;
}

function lineNumbers(text: string, offsets: number[]): number[] {
  if (offsets.length === 0) return [];
  const newlines: number[] = [];
  for (
    let at = text.indexOf("\n");
    at !== -1;
    at = text.indexOf("\n", at + 1)
  ) {
    newlines.push(at);
  }
  return offsets.map((offset) => countBelow(newlines, offset) + 1);
}

function countBelow(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] ?? 0) < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

const RULES: Rule[] = [
  pattern("private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/),
  pattern("aws-access-key-id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/),
  pattern(
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  ),
  pattern("slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/),
  pattern("anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/),
  pattern("openai-key", /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/),
  pattern("google-api-key", /\bAIza[0-9A-Za-z_-]{35}/),
  pattern("stripe-live-key", /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/),
  lineRule("jwt", hasJwt),
  { id: "credential-assignment", lines: credentialLines },
  { id: "url-credentials", lines: urlCredentialLines },
];

function hitsIn(text: string): Hit[] {
  return RULES.flatMap((rule) =>
    [...new Set(rule.lines(text))].map((line) => ({ rule: rule.id, line })),
  ).sort((a, b) => a.line - b.line);
}

export function scanText(text: string, location: string): SecretFinding[] {
  return hitsIn(text).map(({ rule, line }) => ({
    rule,
    location: `${location}:line ${line}`,
  }));
}

function scanValue(value: string, location: string): SecretFinding[] {
  const rules = [...new Set(hitsIn(value).map((hit) => hit.rule))];
  return rules.map((rule) => ({ rule, location }));
}

export function scanEntry(entry: Entry, body: string): SecretFinding[] {
  const frontMatter = Object.entries(entry).flatMap(([key, value]) =>
    scanNode(value, `frontmatter:${key}`),
  );
  return [...frontMatter, ...scanText(body, "body")];
}

function scanNode(value: unknown, location: string): SecretFinding[] {
  if (typeof value === "string") return scanValue(value, location);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      scanNode(item, `${location}[${index}]`),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      scanNode(item, `${location}.${key}`),
    );
  }
  return [];
}

export function decodeTextLike(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function scanAttachment(
  filename: string,
  bytes: Uint8Array,
): SecretFinding[] {
  const nameFindings = scanValue(basename(filename), "attachment:filename");
  const text = decodeTextLike(bytes);
  if (text === undefined) return nameFindings;
  return [...nameFindings, ...scanText(text, "attachment:content")];
}
