import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { promisify } from "node:util";
import { promptInput } from "../src/library-schema.ts";
import { renderPrompt } from "../src/prompt-template.ts";
import { cleanupTempDirs, makeTempDir, newNotebook } from "./fixtures.ts";

after(cleanupTempDirs);
const execute = promisify(execFile);
async function cli(dir: string, ...args: string[]) {
  const { stdout } = await execute("node", [
    "src/cli.ts",
    "--dir",
    dir,
    "--json",
    ...args,
  ]);
  return JSON.parse(stdout);
}
it("saves and renders prompts literally through the CLI without writing", async () => {
  const dir = await newNotebook();
  const temp = await makeTempDir();
  const input = join(temp, "input.json"),
    values = join(temp, "values.json");
  await writeFile(
    input,
    JSON.stringify({
      title: "Explain",
      description: "Visual explanation",
      template: "Explain {{concept}} and {{concept}}",
      inputs: [{ name: "concept", description: "Subject" }],
    }),
  );
  const saved = (await cli(dir, "prompt", "create", "--input", input)).data;
  await writeFile(
    values,
    JSON.stringify({ concept: "{{other}} $(do-not-run)" }),
  );
  const rendered = (
    await cli(dir, "prompt", "render", saved.id, "--values", values)
  ).data;
  assert.equal(
    rendered.text,
    "Explain {{other}} $(do-not-run) and {{other}} $(do-not-run)",
  );
  assert.equal(
    (await cli(dir, "prompt", "history", saved.id)).data.versions.length,
    1,
  );
  assert.equal((await cli(dir, "prompt", "search", "Visual")).data.total, 1);
  const usage = (error: unknown) =>
    JSON.parse((error as { stdout: string }).stdout).error.code === "USAGE";
  for (const args of [
    ["archive", saved.id, "--expected-revision", saved.revision],
    ["unarchive", saved.id, "--expected-revision", saved.revision],
    ["search", "--include-archived"],
  ])
    await assert.rejects(cli(dir, "prompt", ...args), usage);
});
it("rejects missing and unknown inputs and bounds repeated expansion", () => {
  const prompt = promptInput({
    title: "x",
    description: "y",
    template: "{{x}} {{x}} {{x}}",
    inputs: [{ name: "x", description: "Input" }],
  });
  assert.throws(() => renderPrompt(prompt, {}));
  assert.throws(() => renderPrompt(prompt, { x: "a", unknown: "b" }));
  assert.throws(() => renderPrompt(prompt, { x: "a".repeat(2 * 1024 * 1024) }));
});

it("versions and restores prompts without changing other items", async () => {
  const dir = await newNotebook(),
    temp = await makeTempDir(),
    input = join(temp, "prompt.json");
  await writeFile(
    input,
    JSON.stringify({
      title: "Prompt",
      description: "Initial",
      template: "Explain {{x}}",
      inputs: [{ name: "x", description: "Subject", default: "Git" }],
    }),
  );
  const saved = (await cli(dir, "prompt", "create", "--input", input)).data;
  await writeFile(
    input,
    JSON.stringify({
      description: "Changed",
      change_summary: "Clarify purpose",
    }),
  );
  const changed = (
    await cli(
      dir,
      "prompt",
      "update",
      saved.id,
      "--expected-revision",
      saved.revision,
      "--input",
      input,
    )
  ).data;
  const version = (
    await cli(dir, "prompt", "version", saved.id, "--commit", saved.commit)
  ).data;
  assert.equal(version.item.description, "Initial");
  const restored = (
    await cli(
      dir,
      "prompt",
      "restore",
      saved.id,
      "--commit",
      saved.commit,
      "--expected-revision",
      changed.revision,
    )
  ).data;
  assert.notEqual(restored.commit, saved.commit);
  assert.equal(restored.url, saved.url);
  assert.equal(
    (await cli(dir, "prompt", "read", saved.id)).data.item.description,
    "Initial",
  );
});
