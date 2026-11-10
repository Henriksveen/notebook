import { randomUUID } from "node:crypto";
import { attemptBackup, recordBackup } from "./backup.ts";
import { NotebookError } from "./errors.ts";
import { gitBytes, headCommit } from "./git.ts";
import {
  type Entity,
  type Item,
  type Page,
  type Prompt,
  pageInput,
  patchInput,
  promptInput,
  text,
} from "./library-schema.ts";
import {
  itemBase,
  itemFiles,
  type LoadedItem,
  readItem,
} from "./library-store.ts";
import { publish, recoverTransaction } from "./library-transaction.ts";
import { withWriteLock } from "./lock.ts";
import { assertNotebook } from "./notebook.ts";

export { readItem } from "./library-store.ts";
export function itemUrl(entity: Entity, id: string, port = 43127): string {
  return `http://127.0.0.1:${port}/${entity === "page" ? "pages" : "prompts"}/${id}`;
}
function userFields(loaded: LoadedItem): Record<string, unknown> {
  const item = loaded.item;
  return item.entity === "page"
    ? {
        title: item.title,
        summary: item.summary,
        project: item.project,
        topics: item.topics,
        kind: item.kind,
        sources: item.sources,
        ...(loaded.context === undefined ? {} : { context: loaded.context }),
        ...(item.prompt ? { prompt: item.prompt } : {}),
      }
    : {
        title: item.title,
        description: item.description,
        project: item.project,
        topics: item.topics,
        template: item.template,
        inputs: item.inputs,
        ...(item.example ? { example: item.example } : {}),
      };
}
async function provenance(dir: string, item: Item) {
  if (item.entity !== "page" || !item.prompt) return;
  const candidates = await history(dir, "prompt", item.prompt.id);
  if (
    !candidates.some(
      (candidate) => candidate.revision === item.prompt?.revision,
    )
  )
    throw new NotebookError(
      "VALIDATION_FAILED",
      "prompt revision is not in reachable history",
    );
}
async function result(dir: string, item: Item, commit: string, port = 43127) {
  const loaded = await readItem(dir, item.entity, item.id, commit);
  const backup = await attemptBackup(dir);
  const warnings = await recordBackup(dir, backup);
  return {
    entity: item.entity,
    id: item.id,
    title: item.title,
    url: itemUrl(item.entity, item.id, port),
    revision: loaded.revision,
    commit,
    change_summary: item.change_summary,
    backup,
    warnings,
  };
}
export async function createItem(
  dir: string,
  entity: Entity,
  value: unknown,
  html?: string,
  port?: number,
) {
  const data = entity === "page" ? pageInput(value) : promptInput(value);
  return withWriteLock(dir, async () => {
    await recoverTransaction(dir);
    await assertNotebook(dir);
    const now = new Date().toISOString();
    const id = randomUUID();
    const common = {
      schema_version: 2 as const,
      id,
      created_at: now,
      updated_at: now,
      change_summary: entity === "page" ? "Created page" : "Created prompt",
    };
    let item: Item;
    let context: string | undefined;
    if (entity === "page") {
      const input = pageInput(data);
      const { context: ctx, ...meta } = input;
      context = ctx;
      item = {
        ...meta,
        ...common,
        entity: "page",
      };
    } else item = { ...promptInput(data), ...common, entity: "prompt" };
    await provenance(dir, item);
    const commit = await publish(
      dir,
      itemFiles(item, html, context),
      `notebook: create ${entity} ${id} ${item.title}`,
    );
    return result(dir, item, commit, port);
  });
}
async function checked(
  dir: string,
  entity: Entity,
  id: string,
  expected: string,
): Promise<LoadedItem> {
  await recoverTransaction(dir);
  await assertNotebook(dir);
  const current = await readItem(dir, entity, id);
  if (current.revision !== expected)
    throw new NotebookError(
      "STALE_REVISION",
      "item changed; read it again before updating",
      { current_revision: current.revision },
    );
  return current;
}
export async function updateItem(
  dir: string,
  entity: Entity,
  id: string,
  expected: string,
  value: unknown,
  html?: string,
  port?: number,
) {
  const patch = patchInput(entity, value);
  return withWriteLock(dir, async () => {
    const current = await checked(dir, entity, id, expected);
    const { change_summary, ...changes } = patch;
    const merged = { ...userFields(current), ...changes };
    for (const field of ["context", "prompt"])
      if (merged[field] === null) delete merged[field];
    let item: Item;
    let context: string | undefined;
    if (entity === "page") {
      const { context: ctx, ...data } = pageInput(merged);
      context = ctx;
      item = { ...current.item, ...data, entity: "page" } as Page;
      if (!data.prompt && item.entity === "page") delete item.prompt;
    } else
      item = {
        ...current.item,
        ...promptInput(merged),
        entity: "prompt",
      } as Prompt;
    item.updated_at = new Date().toISOString();
    item.change_summary = text(change_summary, "change_summary", 500);
    await provenance(dir, item);
    const commit = await publish(
      dir,
      itemFiles(item, html ?? current.html, context),
      `notebook: update ${entity} ${id} ${item.title}`,
    );
    return result(dir, item, commit, port);
  });
}
export async function history(dir: string, entity: Entity, id: string) {
  await assertNotebook(dir);
  const base = itemBase(entity, id);
  const head = await headCommit(dir);
  const commits = (
    await gitBytes(dir, ["log", "--format=%H", head ?? "HEAD", "--", base])
  )
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const versions: Array<{
    commit: string;
    revision: string;
    timestamp: string;
    change_summary: string;
  }> = [];
  for (const commit of commits) {
    const loaded = await readItem(dir, entity, id, commit);
    versions.push({
      commit,
      revision: loaded.revision,
      timestamp: loaded.item.updated_at,
      change_summary: loaded.item.change_summary,
    });
  }
  if (!versions.length)
    throw new NotebookError("NOT_FOUND", "item has no history");
  return versions;
}
export async function restoreItem(
  dir: string,
  entity: Entity,
  id: string,
  expected: string,
  commit: string,
  port?: number,
) {
  return withWriteLock(dir, async () => {
    const current = await checked(dir, entity, id, expected);
    const selected = await readItem(dir, entity, id, commit);
    const item = {
      ...selected.item,
      id,
      created_at: current.item.created_at,
      updated_at: new Date().toISOString(),
      change_summary: `Restored ${commit}`,
    };
    await provenance(dir, item);
    const saved = await publish(
      dir,
      itemFiles(item, selected.html, selected.context),
      `notebook: restore ${entity} ${id}`,
    );
    return result(dir, item, saved, port);
  });
}
