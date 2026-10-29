import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ENTRY_LIMIT,
  FRONT_MATTER_LIMIT,
  parseEntry,
  serializeEntry,
} from "../src/frontmatter.ts";
import { makeEntry } from "./fixtures.ts";

const encoder = new TextEncoder();

function serialized(
  entryOverrides: Parameters<typeof makeEntry>[0] = {},
  body = "# Heading\n\nBody text.\n",
) {
  const result = serializeEntry({ entry: makeEntry(entryOverrides), body });
  assert.equal(result.ok, true);
  return result.ok ? result.value : "";
}

function parse(text: string) {
  return parseEntry(encoder.encode(text));
}

function reserialize(text: string): string | undefined {
  const parsed = parse(text);
  if (!parsed.ok) return undefined;
  const again = serializeEntry(parsed.value);
  return again.ok ? again.value : undefined;
}

function frontMatterOf(text: string): string {
  return text.slice(4, text.indexOf("\n---\n") + 1);
}

describe("front matter serialization", () => {
  it("writes keys in the documented order", () => {
    const text = serialized({ sources: [{ kind: "conversation", ref: "s1" }] });
    const keys = text
      .split("\n")
      .filter((line) => /^[a-z_]+: /.test(line))
      .map((line) => line.split(":")[0]);
    assert.deepEqual(keys, [
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
      "sources",
      "attachments",
    ]);
  });

  it("round-trips byte-identically", () => {
    const text = serialized({
      title: 'Quotes "and" \\ slashes ✓ ünïcode',
      status: "archived",
      archived_from: "ready",
      sources: [
        { kind: "url", url: "https://example.com/?a=1&b=2", title: "Example" },
      ],
      topics: ["zeta", "alpha"],
    });
    const parsed = parse(text);
    assert.equal(parsed.ok && parsed.value.entry.archived_from, "ready");
    assert.equal(reserialize(text), text);
  });

  it("normalizes topics on write and keeps the body untouched", () => {
    const body = "line one\r\n\n---\ntrailing";
    const text = serialized({ topics: ["Zeta", "alpha", "alpha"] }, body);
    assert.ok(text.includes('topics: ["alpha","zeta"]\n'));
    const parsed = parse(text);
    assert.equal(parsed.ok && parsed.value.body, body);
  });

  it("round-trips an empty body", () => {
    const text = serialized({}, "");
    assert.equal(reserialize(text), text);
  });

  it("refuses to serialize an invalid entry", () => {
    const result = serializeEntry({
      entry: { ...makeEntry(), title: "" },
      body: "x",
    });
    assert.equal(result.ok, false);
  });
});

describe("front matter parsing", () => {
  const canonical = frontMatterOf(serialized());
  const frame = (frontMatter: string, body = "Body\n") =>
    `---\n${frontMatter}---\n${body}`;

  it("parses a canonical entry", () => {
    const parsed = parse(serialized());
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.body, "# Heading\n\nBody text.\n");
  });

  it("rejects duplicate keys", () => {
    const result = parse(frame(`${canonical}title: "Other"\n`));
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.errors[0].message, "is invalid YAML (DUPLICATE_KEY)");
  });

  it("rejects aliases", () => {
    const result = parse(
      frame(canonical.replace("sources: []", "sources: &s []\nextra: *s")),
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.errors[0].message, "aliases are not allowed");
  });

  it("rejects anchors", () => {
    const result = parse(
      frame(canonical.replace("sources: []", "sources: &s []")),
    );
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.equal(result.errors[0].message, "anchors are not allowed");
  });

  it("rejects custom and explicit tags", () => {
    const custom = parse(
      frame(canonical.replace('type: "research"', "type: !custom research")),
    );
    assert.equal(custom.ok, false);
    const explicit = parse(
      frame(canonical.replace('type: "research"', 'type: !!str "research"')),
    );
    assert.equal(explicit.ok, false);
  });

  it("rejects unknown keys", () => {
    const result = parse(frame(`${canonical}extra: 1\n`));
    assert.equal(result.ok, false);
  });

  it("rejects missing delimiters and invalid UTF-8", () => {
    assert.equal(parse("title: nope\n").ok, false);
    assert.equal(parse(`---\n${canonical}`).ok, false);
    const invalidUtf8 = new Uint8Array([
      0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a,
    ]);
    assert.equal(parseEntry(invalidUtf8).ok, false);
  });

  it("enforces the front matter size limit", () => {
    const result = parse(
      frame(`${canonical}x: "${"a".repeat(FRONT_MATTER_LIMIT)}"\n`),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].message, "exceeds 64 KiB");
  });

  it("enforces the entry size limit", () => {
    const result = parseEntry(new Uint8Array(ENTRY_LIMIT + 1));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors[0].message, "exceeds 2 MiB");
  });
});
