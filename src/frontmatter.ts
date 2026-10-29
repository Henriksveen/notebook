import { parseDocument, visit } from "yaml";
import {
  type Entry,
  invalidResult,
  type Validation,
  validateEntry,
} from "./schema.ts";

export const FRONT_MATTER_LIMIT = 64 * 1024;
export const ENTRY_LIMIT = 2 * 1024 * 1024;

const DELIMITER = "---\n";
const KEY_ORDER: (keyof Entry)[] = [
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
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ParsedEntry {
  entry: Entry;
  body: string;
}

export function serializeEntry(document: ParsedEntry): Validation<string> {
  const checked = validateEntry(document.entry);
  if (!checked.ok) return checked;
  const entry = checked.value;
  const frontMatter = KEY_ORDER.filter((key) => entry[key] !== undefined)
    .map((key) => `${key}: ${JSON.stringify(entry[key])}\n`)
    .join("");
  if (encoder.encode(frontMatter).byteLength > FRONT_MATTER_LIMIT) {
    return invalidResult("front matter", "exceeds 64 KiB");
  }
  const text = `${DELIMITER}${frontMatter}${DELIMITER}${document.body}`;
  if (encoder.encode(text).byteLength > ENTRY_LIMIT)
    return invalidResult("entry", "exceeds 2 MiB");
  return { ok: true, value: text };
}

export function parseEntry(bytes: Uint8Array): Validation<ParsedEntry> {
  if (bytes.byteLength > ENTRY_LIMIT)
    return invalidResult("entry", "exceeds 2 MiB");
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return invalidResult("entry", "is not valid UTF-8");
  }
  if (!text.startsWith(DELIMITER))
    return invalidResult("front matter", "must start with a --- line");
  const closing = findClosingDelimiter(text);
  if (closing < 0)
    return invalidResult("front matter", "must end with a --- line");
  const frontMatter = text.slice(DELIMITER.length, closing);
  if (encoder.encode(frontMatter).byteLength > FRONT_MATTER_LIMIT) {
    return invalidResult("front matter", "exceeds 64 KiB");
  }
  const data = parseStrictYaml(frontMatter);
  if (!data.ok) return data;
  const checked = validateEntry(data.value);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      entry: checked.value,
      body: text.slice(closing + DELIMITER.length),
    },
  };
}

function findClosingDelimiter(text: string): number {
  if (text.startsWith(DELIMITER, DELIMITER.length)) return DELIMITER.length;
  const index = text.indexOf(`\n${DELIMITER}`, DELIMITER.length - 1);
  return index < 0 ? -1 : index + 1;
}

function parseStrictYaml(source: string): Validation<unknown> {
  const doc = parseDocument(source, {
    uniqueKeys: true,
    schema: "core",
    merge: false,
  });
  if (doc.errors.length > 0)
    return invalidResult(
      "front matter",
      `is invalid YAML (${doc.errors[0].code})`,
    );
  let aliased = false;
  visit(doc, {
    Alias() {
      aliased = true;
      return visit.BREAK;
    },
  });
  if (aliased) return invalidResult("front matter", "aliases are not allowed");
  let problem: string | undefined;
  visit(doc, {
    Node(_key, node) {
      if (node.tag !== undefined) problem ??= "tags are not allowed";
      else if ("anchor" in node && node.anchor !== undefined)
        problem ??= "anchors are not allowed";
    },
  });
  if (problem) return invalidResult("front matter", problem);
  return { ok: true, value: doc.toJS() };
}
