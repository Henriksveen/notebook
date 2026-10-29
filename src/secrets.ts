import { basename } from "node:path";
import type { Entry } from "./schema.ts";

export interface SecretFinding {
  rule: string;
  location: string;
}

interface Rule {
  id: string;
  matches: (line: string) => boolean;
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
  /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?([^\s"'`]{8,})/gi;
const URL_CREDENTIALS =
  /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+):([^\s/@]+)@[^\s/]/gi;

function pattern(id: string, regex: RegExp): Rule {
  return { id, matches: (line) => regex.test(line) };
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.some((placeholder) => placeholder.test(value));
}

function hasCredentialAssignment(line: string): boolean {
  return [...line.matchAll(CREDENTIAL_ASSIGNMENT)].some(
    (match) => !isPlaceholder(match[1]),
  );
}

function hasUrlCredentials(line: string): boolean {
  return [...line.matchAll(URL_CREDENTIALS)].some(
    (match) => !isPlaceholder(match[2]),
  );
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
  pattern("jwt", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/),
  { id: "credential-assignment", matches: hasCredentialAssignment },
  { id: "url-credentials", matches: hasUrlCredentials },
];

function rulesMatching(line: string): string[] {
  return RULES.filter((rule) => rule.matches(line)).map((rule) => rule.id);
}

export function scanText(text: string, location: string): SecretFinding[] {
  return text.split(/\r?\n/).flatMap((line, index) =>
    rulesMatching(line).map((rule) => ({
      rule,
      location: `${location}:line ${index + 1}`,
    })),
  );
}

function scanValue(value: string, location: string): SecretFinding[] {
  return rulesMatching(value).map((rule) => ({ rule, location }));
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
