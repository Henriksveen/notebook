import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Entry } from "../src/schema.ts";
import {
  type SearchDocument,
  searchEntries,
  searchNotebook,
} from "../src/search.ts";
import { makeEntry, makeTempDir, writeEntryFile } from "./fixtures.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function doc(
  n: number,
  overrides: Partial<Entry>,
  body = "Body.",
): SearchDocument {
  return { entry: makeEntry({ id: id(n), ...overrides }), body };
}

const idsOf = (hits: { id: string }[]) => hits.map((hit) => hit.id);

describe("search semantics", () => {
  const corpus = [
    doc(1, {
      title: "Zebra notes",
      summary: "plain",
      updated_at: "2026-10-01T00:00:00.000Z",
    }),
    doc(2, {
      title: "Gamma",
      summary: "zebra summary",
      updated_at: "2026-10-02T00:00:00.000Z",
    }),
    doc(
      3,
      {
        title: "Delta",
        summary: "nothing",
        updated_at: "2026-10-03T00:00:00.000Z",
      },
      "zebra in body",
    ),
    doc(
      4,
      {
        title: "Only zebra",
        summary: "x",
        updated_at: "2026-10-04T00:00:00.000Z",
      },
      "beta in body",
    ),
  ];

  it("requires every term to match", () => {
    assert.deepEqual(
      idsOf(searchEntries(corpus, { query: "zebra beta" }).hits),
      [id(4)],
    );
  });

  it("ranks title matches above summary matches above body matches", () => {
    assert.deepEqual(idsOf(searchEntries(corpus, { query: "zebra" }).hits), [
      id(4),
      id(1),
      id(2),
      id(3),
    ]);
  });

  it("returns every match for an empty query, newest first", () => {
    const result = searchEntries(corpus, {});
    assert.deepEqual(idsOf(result.hits), [id(4), id(3), id(2), id(1)]);
    assert.equal(result.total, 4);
  });

  it("applies limit and offset", () => {
    const page = searchEntries(corpus, { limit: 2, offset: 1 });
    assert.deepEqual(idsOf(page.hits), [id(3), id(2)]);
    assert.equal(page.total, 4);
    assert.equal(searchEntries(corpus, {}).hits.length, 4);
  });

  it("validates limit and offset", () => {
    assert.throws(() => searchEntries(corpus, { limit: 201 }), {
      code: "USAGE",
    });
    assert.throws(() => searchEntries(corpus, { limit: 0 }), { code: "USAGE" });
    assert.throws(() => searchEntries(corpus, { offset: -1 }), {
      code: "USAGE",
    });
  });

  it("uses a default limit of 20 and a maximum of 200", () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      doc(index + 1, { title: "bulk" }),
    );
    assert.equal(searchEntries(many, { query: "bulk" }).hits.length, 20);
    assert.equal(
      searchEntries(many, { query: "bulk", limit: 200 }).hits.length,
      200,
    );
    assert.equal(searchEntries(many, { query: "bulk" }).total, 250);
  });
});

describe("search normalization and filters", () => {
  it("matches across Unicode compatibility forms and case", () => {
    const corpus = [doc(1, { title: "café notes" })];
    assert.equal(searchEntries(corpus, { query: "Ｃafé" }).hits.length, 1);
    assert.equal(searchEntries(corpus, { query: "CAFÉ" }).hits.length, 1);
    assert.equal(
      searchEntries([doc(2, { title: "Ｃafé" })], { query: "café" }).hits
        .length,
      1,
    );
  });

  it("filters by project, topic, type and status", () => {
    const corpus = [
      doc(1, {
        project: "Alpha",
        topics: ["architecture"],
        type: "research",
        status: "draft",
      }),
      doc(2, {
        project: "Beta",
        topics: ["ops", "architecture"],
        type: "decision",
        status: "ready",
      }),
    ];
    assert.deepEqual(idsOf(searchEntries(corpus, { project: "ALPHA" }).hits), [
      id(1),
    ]);
    assert.deepEqual(
      idsOf(searchEntries(corpus, { topic: "architecture" }).hits),
      [id(1), id(2)],
    );
    assert.deepEqual(idsOf(searchEntries(corpus, { topic: "ops" }).hits), [
      id(2),
    ]);
    assert.deepEqual(idsOf(searchEntries(corpus, { type: "decision" }).hits), [
      id(2),
    ]);
    assert.deepEqual(idsOf(searchEntries(corpus, { status: "ready" }).hits), [
      id(2),
    ]);
  });

  it("excludes archived entries unless requested or filtered for", () => {
    const corpus = [
      doc(1, { title: "shared" }),
      doc(2, { title: "shared", status: "archived", archived_from: "ready" }),
    ];
    assert.deepEqual(idsOf(searchEntries(corpus, { query: "shared" }).hits), [
      id(1),
    ]);
    assert.deepEqual(
      idsOf(
        searchEntries(corpus, { query: "shared", includeArchived: true }).hits,
      ),
      [id(1), id(2)],
    );
    assert.deepEqual(
      idsOf(searchEntries(corpus, { status: "archived" }).hits),
      [id(2)],
    );
  });

  it("includes result URLs for the requested port", () => {
    const [hit] = searchEntries([doc(5, { title: "t" })], { port: 5555 }).hits;
    assert.equal(hit.url, `http://127.0.0.1:5555/entries/${id(5)}`);
  });
});

describe("search over a directory", () => {
  it("loads entries from disk and reports warnings", async () => {
    const dir = await makeTempDir();
    await writeEntryFile(dir, makeEntry({ id: id(9), title: "Disk find" }));
    const result = await searchNotebook(dir, { query: "disk" });
    assert.deepEqual(idsOf(result.hits), [id(9)]);
    assert.deepEqual(result.warnings, []);
  });
});
