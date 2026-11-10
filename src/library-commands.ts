import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Context } from "./commands.ts";
import { NotebookError } from "./errors.ts";
import {
  createItem,
  history,
  itemUrl,
  readItem,
  restoreItem,
  updateItem,
} from "./library.ts";
import { type Entity, HTML_LIMIT, JSON_LIMIT } from "./library-schema.ts";
import { searchLibrary } from "./library-search.ts";
import { assertNotebook } from "./notebook.ts";
import type { Outcome } from "./output.ts";
import { renderPrompt } from "./prompt-template.ts";
import { openNotebook } from "./web/open.ts";

function required(value: string | undefined, flag: string): string {
  if (!value) throw new NotebookError("USAGE", `${flag} is required`);
  return value;
}
export async function regularText(
  path: string,
  limit: number,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new NotebookError(
        "VALIDATION_FAILED",
        "input must be a bounded regular file",
      );
    const bytes = await file.readFile();
    if (bytes.length > limit)
      throw new NotebookError("VALIDATION_FAILED", "input exceeds size limit");
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}
async function jsonInput(path: string | undefined): Promise<unknown> {
  required(path, "--input/--values");
  let bytes = "";
  if (path === "-") {
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      bytes += String(chunk);
      if (Buffer.byteLength(bytes) > JSON_LIMIT)
        throw new NotebookError("VALIDATION_FAILED", "input exceeds 4 MiB");
    }
  } else bytes = await regularText(path ?? "", JSON_LIMIT);
  try {
    return JSON.parse(bytes);
  } catch {
    throw new NotebookError("VALIDATION_FAILED", "invalid JSON input");
  }
}
function outcome(data: unknown): Outcome {
  const result = data as {
    backup?: Outcome["backup"];
    warnings?: string[];
    url?: string;
    revision?: string;
    title?: string;
  };
  const { backup, warnings, ...payload } = result;
  return {
    data: payload,
    backup,
    warnings: warnings ?? [],
    text: JSON.stringify(payload, null, 2),
  };
}
const RULES: Record<string, { count: number; flags: string[] }> = {
  create: { count: 0, flags: ["input", "html"] },
  read: { count: 1, flags: [] },
  update: { count: 1, flags: ["input", "html", "expected-revision"] },
  search: {
    count: -1,
    flags: ["project", "topic", "kind", "limit", "offset"],
  },
  history: { count: 1, flags: [] },
  version: { count: 1, flags: ["commit"] },
  restore: { count: 1, flags: ["commit", "expected-revision"] },
  render: { count: 1, flags: ["values"] },
  open: { count: 1, flags: ["no-browser"] },
};
export async function runLibrary(
  context: Context,
  entity: Entity,
): Promise<Outcome> {
  const { dir, port, positionals, values } = context;
  const [action, ...args] = positionals;
  const rule = Object.hasOwn(RULES, action) ? RULES[action] : undefined;
  if (
    !rule ||
    (rule.count >= 0 && args.length !== rule.count) ||
    (entity === "page" && action === "render")
  )
    throw new NotebookError("USAGE", "invalid item command or arguments");
  const allowed = ["dir", "port", "json", "help", ...rule.flags];
  for (const flag of Object.keys(values))
    if (
      !allowed.includes(flag) ||
      (entity === "prompt" && (flag === "html" || flag === "kind"))
    )
      throw new NotebookError("USAGE", "invalid option for item command");
  await assertNotebook(dir);
  const id = args[0];
  switch (action) {
    case "create":
      return outcome(
        await createItem(
          dir,
          entity,
          await jsonInput(values.input),
          values.html ? await regularText(values.html, HTML_LIMIT) : undefined,
          port,
        ),
      );
    case "read":
      return outcome({
        ...(await readItem(dir, entity, id)),
        url: itemUrl(entity, id, port),
      });
    case "update":
      return outcome(
        await updateItem(
          dir,
          entity,
          id,
          required(values["expected-revision"], "--expected-revision"),
          await jsonInput(values.input),
          values.html ? await regularText(values.html, HTML_LIMIT) : undefined,
          port,
        ),
      );
    case "search":
      return outcome(
        await searchLibrary(dir, entity, {
          query: args.join(" "),
          project: values.project,
          topic: values.topic,
          kind: values.kind,
          limit: values.limit === undefined ? undefined : Number(values.limit),
          offset:
            values.offset === undefined ? undefined : Number(values.offset),
          port,
        }),
      );
    case "history":
      return outcome({ versions: await history(dir, entity, id) });
    case "version":
      return outcome(
        await readItem(dir, entity, id, required(values.commit, "--commit")),
      );
    case "restore":
      return outcome(
        await restoreItem(
          dir,
          entity,
          id,
          required(values["expected-revision"], "--expected-revision"),
          required(values.commit, "--commit"),
          port,
        ),
      );
    case "render": {
      const loaded = await readItem(dir, "prompt", id);
      if (loaded.item.entity !== "prompt")
        throw new NotebookError("NOT_FOUND", "prompt not found");
      return outcome({
        text: renderPrompt(loaded.item, await jsonInput(values.values)),
        revision: loaded.revision,
      });
    }
    case "open": {
      await readItem(dir, entity, id);
      return outcome(
        await openNotebook({
          dir,
          port,
          itemPath: `/${entity === "page" ? "pages" : "prompts"}/${id}`,
          noBrowser: values["no-browser"],
        }),
      );
    }
  }
  throw new NotebookError("USAGE", "unknown item command");
}
