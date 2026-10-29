import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeSlug,
  validateEntry,
  validateEntryInput,
  validateEntryPatch,
} from "../src/schema.ts";
import { makeEntry } from "./fixtures.ts";

const validInput = {
  title: "  Standalone title  ",
  summary: "One sentence.",
  type: "research",
  body: "Body",
};

describe("entry validation", () => {
  it("accepts a valid entry", () => {
    const result = validateEntry(makeEntry());
    assert.equal(result.ok, true);
  });

  it("rejects unknown front matter keys", () => {
    const result = validateEntry({ ...makeEntry(), surprise: true });
    assert.equal(result.ok, false);
    if (!result.ok)
      assert.deepEqual(result.errors, [
        { field: "surprise", message: "is not a known field" },
      ]);
  });

  it("rejects a non-UUID id and a wrong schema version", () => {
    const result = validateEntry({
      ...makeEntry(),
      id: "not-a-uuid",
      schema_version: 2,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.errors.map((error) => error.field),
        ["schema_version", "id"],
      );
    }
  });

  it("rejects multi-line titles and over-long summaries", () => {
    const result = validateEntry({
      ...makeEntry(),
      title: "a\nb",
      summary: "x".repeat(501),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.errors.map((error) => error.field),
        ["title", "summary"],
      );
    }
  });

  it("defaults a blank project to Inbox", () => {
    const result = validateEntry({ ...makeEntry(), project: "   " });
    assert.equal(result.ok && result.value.project, "Inbox");
  });

  it("requires archived_from exactly when archived", () => {
    const missing = validateEntry({ ...makeEntry(), status: "archived" });
    assert.equal(missing.ok, false);
    const bad = validateEntry({
      ...makeEntry(),
      status: "archived",
      archived_from: "archived",
    });
    assert.equal(bad.ok, false);
    const stray = validateEntry({
      ...makeEntry(),
      status: "ready",
      archived_from: "draft",
    });
    assert.equal(stray.ok, false);
    const good = validateEntry({
      ...makeEntry(),
      status: "archived",
      archived_from: "ready",
    });
    assert.equal(good.ok, true);
  });

  it("requires canonical UTC timestamps", () => {
    assert.equal(
      validateEntry({ ...makeEntry(), created_at: "2026-10-29T12:00:00Z" }).ok,
      false,
    );
    assert.equal(
      validateEntry({ ...makeEntry(), updated_at: "2026-02-30T12:00:00.000Z" })
        .ok,
      false,
    );
  });
});

describe("topic and type normalization", () => {
  it("lowercases, dedupes and sorts topics", () => {
    const result = validateEntryInput({
      ...validInput,
      topics: ["Zeta", "alpha", "ALPHA", " beta-2 "],
    });
    assert.deepEqual(result.ok && result.value.topics, [
      "alpha",
      "beta-2",
      "zeta",
    ]);
  });

  it("rejects invalid slugs and more than 20 topics", () => {
    assert.equal(
      validateEntryInput({ ...validInput, topics: ["a_b"] }).ok,
      false,
    );
    assert.equal(
      validateEntryInput({ ...validInput, topics: ["a--b"] }).ok,
      false,
    );
    assert.equal(
      validateEntryInput({ ...validInput, topics: ["x".repeat(51)] }).ok,
      false,
    );
    const many = Array.from({ length: 21 }, (_, i) => `topic-${i}`);
    assert.equal(validateEntryInput({ ...validInput, topics: many }).ok, false);
  });

  it("normalizes slugs with NFKC", () => {
    assert.equal(normalizeSlug("Ｂug-List"), "bug-list");
    assert.equal(normalizeSlug("bad slug"), undefined);
  });

  it("requires a type slug", () => {
    assert.equal(
      validateEntryInput({ ...validInput, type: "How To" }).ok,
      false,
    );
    assert.equal(
      validateEntryInput({ ...validInput, type: "how-to" }).ok,
      true,
    );
  });
});

describe("create input", () => {
  it("defaults project to Inbox and topics/sources to empty arrays", () => {
    const result = validateEntryInput(validInput);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.project, "Inbox");
      assert.deepEqual(result.value.topics, []);
      assert.deepEqual(result.value.sources, []);
      assert.equal(result.value.title, "Standalone title");
    }
  });

  it("rejects managed fields such as id, status and timestamps", () => {
    for (const field of [
      "id",
      "status",
      "created_at",
      "updated_at",
      "attachments",
    ]) {
      const result = validateEntryInput({ ...validInput, [field]: "x" });
      assert.equal(result.ok, false, field);
    }
  });

  it("requires a non-empty body", () => {
    assert.equal(validateEntryInput({ ...validInput, body: "   " }).ok, false);
  });
});

describe("sources", () => {
  const withSource = (source: unknown) =>
    validateEntryInput({ ...validInput, sources: [source] });

  it("accepts url, repo and conversation kinds", () => {
    assert.equal(
      withSource({ kind: "url", url: "https://example.com/a", title: "A" }).ok,
      true,
    );
    assert.equal(
      withSource({
        kind: "repo",
        repo: "github.com/x/y",
        commit: "abc123",
        path: "README.md",
      }).ok,
      true,
    );
    assert.equal(
      withSource({ kind: "conversation", ref: "session-1" }).ok,
      true,
    );
  });

  it("accepts only http and https URLs", () => {
    assert.equal(
      withSource({ kind: "url", url: "http://example.com" }).ok,
      true,
    );
    assert.equal(
      withSource({ kind: "url", url: "javascript:alert(1)" }).ok,
      false,
    );
    assert.equal(
      withSource({ kind: "url", url: "file:///etc/passwd" }).ok,
      false,
    );
    assert.equal(withSource({ kind: "url", url: "not a url" }).ok, false);
  });

  it("rejects unknown kinds and unknown source keys", () => {
    assert.equal(withSource({ kind: "chat", ref: "x" }).ok, false);
    assert.equal(
      withSource({ kind: "conversation", ref: "x", url: "https://example.com" })
        .ok,
      false,
    );
  });
});

describe("patches", () => {
  it("accepts a partial patch of content fields", () => {
    const result = validateEntryPatch({ title: "New", topics: ["b", "a"] });
    assert.deepEqual(result, {
      ok: true,
      value: { title: "New", topics: ["a", "b"] },
    });
  });

  it("rejects empty patches and immutable fields", () => {
    assert.equal(validateEntryPatch({}).ok, false);
    for (const field of [
      "id",
      "created_at",
      "status",
      "attachments",
      "archived_from",
    ]) {
      assert.equal(validateEntryPatch({ [field]: "x" }).ok, false, field);
    }
  });
});
