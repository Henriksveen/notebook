import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeSlug, validateMetadata } from "../src/schema.ts";

const validInput = { title: "Standalone title", summary: "One sentence." };
describe("metadata validation", () => {
  it("normalizes shared fields and rejects invalid titles, summaries, managed and unknown keys", () => {
    const result = validateMetadata({
      ...validInput,
      title: " Title ",
      project: " ",
    });
    assert.ok(result.ok);
    assert.equal(result.value.title, "Title");
    assert.equal(result.value.project, "Inbox");
    assert.deepEqual(result.value.topics, []);
    assert.deepEqual(result.value.sources, []);
    for (const value of [
      { ...validInput, title: "a\nb" },
      { ...validInput, summary: "x".repeat(501) },
      { ...validInput, title: "" },
      { ...validInput, project: "x".repeat(81) },
      { ...validInput, id: "managed" },
      { ...validInput, unknown: true },
    ])
      assert.equal(validateMetadata(value).ok, false);
  });
});
describe("topic normalization", () => {
  it("lowercases, dedupes and sorts topics", () => {
    const result = validateMetadata({
      ...validInput,
      topics: ["Zeta", "alpha", "ALPHA", " beta-2 "],
    });
    assert.deepEqual(result.ok && result.value.topics, [
      "alpha",
      "beta-2",
      "zeta",
    ]);
  });

  it("normalizes topic text and rejects unusable or too many topics", () => {
    const normalized = validateMetadata({
      ...validInput,
      topics: ["a_b", "A--B"],
    });
    assert.ok(normalized.ok);
    assert.deepEqual(normalized.value.topics, ["a-b"]);
    assert.equal(
      validateMetadata({ ...validInput, topics: ["!!!"] }).ok,
      false,
    );
    assert.equal(
      validateMetadata({ ...validInput, topics: ["x".repeat(51)] }).ok,
      false,
    );
    const many = Array.from({ length: 21 }, (_, i) => `topic-${i}`);
    assert.equal(validateMetadata({ ...validInput, topics: many }).ok, false);
  });

  it("normalizes slugs with NFKC", () => {
    assert.equal(normalizeSlug("Ｂug-List"), "bug-list");
    assert.equal(normalizeSlug("Smoke Test"), "smoke-test");
    assert.equal(normalizeSlug("  Café / Ops  "), "cafe-ops");
    assert.equal(normalizeSlug("!!!"), undefined);
    assert.equal(normalizeSlug("x".repeat(51)), undefined);
  });
});
describe("sources", () => {
  const withSource = (source: unknown) =>
    validateMetadata({ ...validInput, sources: [source] });

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
