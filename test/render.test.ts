import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown } from "../src/web/render.ts";
import { ID_1, ID_2 } from "./fixtures.ts";

const ATTACHMENT = ID_2;
const UNKNOWN = "00000000-0000-4000-8000-000000000009";
const context = {
  entryId: ID_1,
  attachmentIds: new Set([ATTACHMENT]),
};

function render(body: string): string {
  return renderMarkdown(body, context);
}

function attributeValues(html: string, name: string): string[] {
  const pattern = new RegExp(`<[a-z]+ [^>]*\\b${name}="([^"]*)"`, "g");
  return [...html.matchAll(pattern)].map((match) => match[1] ?? "");
}

function hrefs(html: string): string[] {
  return attributeValues(html, "href");
}

function srcs(html: string): string[] {
  return attributeValues(html, "src");
}

describe("markdown rendering", () => {
  it("renders raw HTML and script tags as text", () => {
    const html = render(
      "Before <script>alert(1)</script> after\n\n<b>bold</b>",
    );
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<b>"), false);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
  });

  it("never emits event handler attributes on real tags", () => {
    const html = render(
      '<img src=x onerror="alert(1)"> <a onclick="x()">y</a>',
    );
    assert.equal(/<[a-z][^>]*\bon[a-z]+=/i.test(html), false);
    assert.equal(/<img\b/.test(html), false);
    assert.equal(/<a\b/.test(html), false);
  });

  it("drops javascript:, data: and relative links", () => {
    const html = render(
      "[a](javascript:alert(1)) [b](data:text/html,x) [c](/projects) [d](notes.md)",
    );
    assert.deepEqual(hrefs(html), []);
    assert.equal(/href/.test(html), false);
    assert.ok(html.includes("<a>d</a>"));
  });

  it("keeps http, https and mailto links, with rel only on web links", () => {
    const html = render(
      "[site](https://example.com/a) [plain](http://example.org) [mail](mailto:a@example.com)",
    );
    assert.deepEqual(hrefs(html), [
      "https://example.com/a",
      "http://example.org",
      "mailto:a@example.com",
    ]);
    assert.equal(
      html.split('rel="noopener noreferrer"').length - 1,
      2,
      "only http(s) links carry rel",
    );
  });

  it("autolinks bare URLs with rel", () => {
    const html = render("See https://example.com/page for details.");
    assert.deepEqual(hrefs(html), ["https://example.com/page"]);
    assert.ok(html.includes('rel="noopener noreferrer"'));
  });

  it("drops remote and data: image sources", () => {
    const html = render(
      "![remote](https://tracker.example/pixel.png) ![inline](data:image/png;base64,AAAA)",
    );
    assert.deepEqual(srcs(html), []);
    assert.equal(html.includes("tracker.example"), false);
    assert.equal(html.includes("data:image"), false);
    assert.ok(html.includes('alt="remote"'));
  });

  it("rewrites known attachment references to entry attachment paths", () => {
    const html = render(
      `![diagram](attachment:${ATTACHMENT}) [file](attachment:${ATTACHMENT})`,
    );
    const path = `/attachments/${ID_1}/${ATTACHMENT}`;
    assert.deepEqual(srcs(html), [path]);
    assert.deepEqual(hrefs(html), [path]);
  });

  it("drops attachment references that are not known to the entry", () => {
    const html = render(
      `![x](attachment:${UNKNOWN}) [y](attachment:../../etc/passwd) [z](attachment:${UNKNOWN})`,
    );
    assert.deepEqual(srcs(html), []);
    assert.deepEqual(hrefs(html), []);
    assert.equal(html.includes("/attachments/"), false);
  });

  it("does not let raw attachment paths bypass the allowlist", () => {
    const html = render(
      `[raw](/attachments/${ID_1}/${ATTACHMENT}) ![raw](/attachments/../x.png) ![other](/attachments/${UNKNOWN}/../../x)`,
    );
    assert.deepEqual(hrefs(html), [`/attachments/${ID_1}/${ATTACHMENT}`]);
    assert.deepEqual(srcs(html), []);
    assert.equal(html.includes("x.png"), false);
  });

  it("renders the SPEC allowlist of structure", () => {
    const html = render(
      [
        "# Title",
        "",
        "- one",
        "- two",
        "",
        "1. first",
        "",
        "> quoted",
        "",
        "`code` and *em* and **strong** and ~~gone~~",
        "",
        "```",
        "const x = 1;",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "---",
        "",
        "line one  ",
        "line two",
      ].join("\n"),
    );
    for (const tag of [
      "<h1>",
      "<ul>",
      "<ol>",
      "<li>",
      "<blockquote>",
      "<code>",
      "<pre>",
      "<em>",
      "<strong>",
      "<del>gone</del>",
      "<table>",
      "<thead>",
      "<tbody>",
      "<th>",
      "<td>",
      "<hr",
      "<br",
    ]) {
      assert.ok(html.includes(tag), `expected ${tag}`);
    }
    assert.equal(html.includes("<s>"), false);
    assert.equal(/\sclass=/.test(html), false);
    assert.equal(/\sstyle=/.test(html), false);
  });
});
