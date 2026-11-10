import { parseDocument, stringify } from "yaml";
import { NotebookError } from "./errors.ts";
import { gitBytes, reachableCommit } from "./git.ts";
import {
  type Entity,
  HTML_LIMIT,
  type Item,
  invalid,
  META_LIMIT,
  object,
  TEXT_LIMIT,
  text,
  validateItem,
} from "./library-schema.ts";
import { isValidId } from "./paths.ts";
import { sha256Hex } from "./revision.ts";
import { scanDocument, scanText } from "./secrets.ts";

function parseLibraryYaml(bytes: string): unknown {
  const document = parseDocument(bytes, { logLevel: "silent" });
  if (document.errors.length || document.warnings.length)
    invalid("invalid library YAML");
  return document.toJS({ maxAliasCount: 50 });
}
export interface LoadedItem {
  item: Item;
  html?: string;
  context?: string;
  revision: string;
  commit: string;
}
export type ItemFiles = Record<string, string | null>;
export function itemBase(entity: Entity, id: string): string {
  if (!isValidId(id))
    throw new NotebookError("USAGE", "item ID must be a UUID v4");
  return entity === "page" ? `pages/${id}/` : `prompts/${id}.md`;
}
export function revisionOf(files: ItemFiles): string {
  return sha256Hex(
    JSON.stringify([
      2,
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => [
          path,
          bytes === null ? null : Buffer.byteLength(bytes),
          bytes === null ? null : sha256Hex(bytes),
        ]),
    ]),
  );
}
export function itemFiles(
  item: Item,
  html?: string,
  context?: string,
): ItemFiles {
  const findings = [
    ...scanDocument(item, html ?? ""),
    ...(context === undefined ? [] : scanText(context, "context")),
  ];
  if (findings.length)
    throw new NotebookError(
      "SECRET_DETECTED",
      "possible secret; nothing was written",
      { findings },
    );
  const base = itemBase(item.entity, item.id);
  if (item.entity === "prompt") {
    const { template, ...meta } = item;
    const header = stringify(meta);
    if (Buffer.byteLength(header) > META_LIMIT)
      invalid("prompt metadata exceeds 64 KiB");
    const bytes = `---\n${header}---\n${template}`;
    if (Buffer.byteLength(bytes) > TEXT_LIMIT)
      invalid("prompt record exceeds 2 MiB");
    return { [base]: bytes };
  }
  const header = stringify(item);
  if (Buffer.byteLength(header) > META_LIMIT)
    invalid("page metadata exceeds 64 KiB");
  text(html, "HTML", HTML_LIMIT, true);
  if (context !== undefined) text(context, "context", TEXT_LIMIT, true);
  return {
    [`${base}page.yaml`]: header,
    [`${base}index.html`]: html ?? "",
    [`${base}context.md`]: context ?? null,
  };
}
export async function treeFiles(
  dir: string,
  commit: string,
  base: string,
): Promise<Map<string, { size: number }>> {
  const output = await gitBytes(dir, [
    "ls-tree",
    "-r",
    "-l",
    "-z",
    commit,
    "--",
    base,
  ]);
  const result = new Map<string, { size: number }>();
  for (const line of output.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(line);
    if (match?.[1] !== "100644")
      throw new NotebookError(
        "UNSAFE_PATH",
        "library files must be regular non-executable files",
      );
    result.set(match[4], { size: Number(match[3]) });
  }
  return result;
}
export async function readItem(
  dir: string,
  entity: Entity,
  id: string,
  at?: string,
): Promise<LoadedItem> {
  const base = itemBase(entity, id);
  const commit = await reachableCommit(dir, at);
  const tree = await treeFiles(dir, commit, base);
  if (!tree.size)
    throw new NotebookError("NOT_FOUND", "library item not found");
  const paths =
    entity === "page"
      ? [`${base}page.yaml`, `${base}index.html`, `${base}context.md`]
      : [base];
  if ([...tree.keys()].some((path) => !paths.includes(path)))
    invalid("unexpected file in library item");
  const files: ItemFiles = {};
  for (const [index, path] of paths.entries()) {
    const record = tree.get(path);
    if (!record) {
      if (entity === "page" && index === 2) {
        files[path] = null;
        continue;
      }
      invalid("incomplete library item");
    }
    const limit =
      entity === "page"
        ? index === 0
          ? META_LIMIT
          : index === 1
            ? HTML_LIMIT
            : TEXT_LIMIT
        : TEXT_LIMIT;
    if (record.size > limit) invalid("library file exceeds size limit");
    files[path] = (
      await gitBytes(dir, ["cat-file", "blob", `${commit}:${path}`])
    ).toString("utf8");
  }
  let raw: unknown;
  let html: string | undefined;
  let context: string | undefined;
  try {
    if (entity === "page") {
      raw = parseLibraryYaml(files[paths[0]] ?? "");
      html = files[paths[1]] ?? "";
      context = files[paths[2]] ?? undefined;
      text(html, "HTML", HTML_LIMIT, true);
      if (context !== undefined) text(context, "context", TEXT_LIMIT, true);
    } else {
      const bytes = files[base] ?? "";
      const end = bytes.indexOf("\n---\n", 4);
      if (
        !bytes.startsWith("---\n") ||
        end < 0 ||
        Buffer.byteLength(bytes.slice(0, end)) > META_LIMIT
      )
        invalid("invalid prompt front matter");
      raw = {
        ...object(parseLibraryYaml(bytes.slice(4, end))),
        template: bytes.slice(end + 5),
      };
    }
  } catch (error) {
    if (error instanceof NotebookError) throw error;
    invalid("invalid library YAML");
  }
  const item = validateItem(raw);
  if (item.entity !== entity || item.id !== id)
    invalid("item identity does not match its path");
  return { item, html, context, revision: revisionOf(files), commit };
}
export async function listItems(
  dir: string,
  entity: Entity,
  at?: string,
): Promise<{ items: LoadedItem[]; warnings: string[] }> {
  const commit = await reachableCommit(dir, at);
  const directory = entity === "page" ? "pages" : "prompts";
  const rootEntry = (
    await gitBytes(dir, ["ls-tree", commit, "--", directory])
  ).toString("utf8");
  if (!rootEntry) return { items: [], warnings: [] };
  if (!rootEntry.startsWith("040000 tree "))
    throw new NotebookError("UNSAFE_PATH", "library root must be a directory");
  const output = await gitBytes(dir, [
    "ls-tree",
    "--name-only",
    ...(entity === "prompt" ? ["-r"] : []),
    `${commit}:${directory}`,
  ]);
  const ids = output
    .toString("utf8")
    .split("\n")
    .map((name) => (entity === "prompt" ? name.replace(/\.md$/, "") : name))
    .filter(isValidId);
  const items: LoadedItem[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    try {
      items.push(await readItem(dir, entity, id, commit));
    } catch {
      warnings.push(`could not load ${entity} ${id}`);
    }
  }
  return { items, warnings };
}
