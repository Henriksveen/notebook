import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { promisify } from "node:util";
import {
  cleanupTempDirs,
  git,
  makeBareRemote,
  makeTempDir,
  newNotebook,
} from "./fixtures.ts";

after(cleanupTempDirs);
const execute = promisify(execFile);
it("CLI journey covers evolving concepts, prompts, history and backup", async () => {
  const dir = await newNotebook(),
    temp = await makeTempDir();
  const input = join(temp, "input.json"),
    html = join(temp, "page.html"),
    values = join(temp, "values.json");
  async function cli(...args: string[]) {
    const { stdout } = await execute("node", [
      "src/cli.ts",
      "--dir",
      dir,
      "--json",
      ...args,
    ]);
    return JSON.parse(stdout);
  }
  async function payload(data: unknown) {
    await writeFile(input, JSON.stringify(data));
    return input;
  }
  const prompt = (
    await cli(
      "prompt",
      "create",
      "--input",
      await payload({
        title: "Explain visually",
        description: "Visual learning",
        template: "Explain {{concept}}",
        inputs: [{ name: "concept", description: "Subject" }],
      }),
    )
  ).data;
  await writeFile(values, JSON.stringify({ concept: "Git" }));
  assert.equal(
    (await cli("prompt", "render", prompt.id, "--values", values)).data.text,
    "Explain Git",
  );
  await writeFile(
    html,
    "<button id='step'>Step</button><script>document.querySelector('#step').onclick=()=>document.body.dataset.clicked='yes'</script><p>uniquevisibleterm</p><style>hiddenstyleterm{}</style>",
  );
  const page = (
    await cli(
      "page",
      "create",
      "--input",
      await payload({
        title: "Git",
        summary: "Visual guide",
        kind: "concept",
        context: "privatecontextterm",
        prompt: { id: prompt.id, revision: prompt.revision },
      }),
      "--html",
      html,
    )
  ).data;
  await cli(
    "prompt",
    "update",
    prompt.id,
    "--expected-revision",
    prompt.revision,
    "--input",
    await payload({
      description: "Updated prompt",
      change_summary: "Clarify purpose",
    }),
  );
  const updated = (
    await cli(
      "page",
      "update",
      page.id,
      "--expected-revision",
      page.revision,
      "--input",
      await payload({ context: null, change_summary: "Remove context" }),
    )
  ).data;
  assert.equal(updated.url, page.url);
  assert.equal(
    (await cli("page", "read", page.id)).data.item.prompt.revision,
    prompt.revision,
  );
  assert.equal(
    (await cli("page", "search", "uniquevisibleterm")).data.total,
    1,
  );
  assert.equal(
    (await cli("page", "search", "privatecontextterm")).data.total,
    0,
  );
  assert.equal((await cli("page", "search", "hiddenstyleterm")).data.total, 0);
  await cli(
    "page",
    "restore",
    page.id,
    "--commit",
    page.commit,
    "--expected-revision",
    updated.revision,
  );
  assert.equal(
    (await cli("page", "read", page.id)).data.context,
    "privatecontextterm",
  );
  const remote = await makeBareRemote();
  await git(dir, ["remote", "add", "origin", remote]);
  await cli("backup");
  assert.equal(
    await git(dir, ["rev-parse", "HEAD"]),
    await git(remote, ["rev-parse", "main"]),
  );
});
