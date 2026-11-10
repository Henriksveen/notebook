import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pageInput,
  patchInput,
  promptInput,
  TEXT_LIMIT,
} from "../src/library-schema.ts";

describe("library contracts", () => {
  it("normalizes metadata while requiring a page kind", () => {
    const page = pageInput({
      title: " Rebasing ",
      summary: "A visual guide",
      kind: "concept",
      topics: ["Git workflows"],
    });
    assert.equal(page.title, "Rebasing");
    assert.deepEqual(page.topics, ["git-workflows"]);
    assert.equal(page.project, "Inbox");
    assert.throws(() => pageInput({ title: "x", summary: "y", kind: "other" }));
    assert.throws(() => pageInput({ ...page, id: "managed" }));
  });
  it("checks context limits and partial patch intent", () => {
    assert.throws(() =>
      pageInput({
        title: "x",
        summary: "y",
        kind: "concept",
        context: "a".repeat(TEXT_LIMIT + 1),
      }),
    );
    assert.deepEqual(
      patchInput("page", { context: null, change_summary: "Remove context" }),
      { context: null, change_summary: "Remove context" },
    );
    assert.throws(() => patchInput("page", { title: "x" }));
    assert.throws(() =>
      patchInput("page", { archived: true, change_summary: "x" }),
    );
  });
  it("validates template definitions, defaults and managed keys", () => {
    const prompt = promptInput({
      title: "Explain",
      description: "Visual explanations",
      template: "Explain {{concept}} twice: {{concept}}",
      inputs: [{ name: "concept", description: "Subject", default: "Git" }],
    });
    assert.equal(prompt.inputs.length, 1);
    assert.throws(() => promptInput({ ...prompt, inputs: [] }));
    assert.throws(() =>
      promptInput({ ...prompt, inputs: [...prompt.inputs, ...prompt.inputs] }),
    );
    assert.throws(() =>
      promptInput({
        ...prompt,
        inputs: [{ name: "concept", description: "Subject", default: 42 }],
      }),
    );
  });
});
