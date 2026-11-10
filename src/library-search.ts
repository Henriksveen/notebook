import sanitizeHtml from "sanitize-html";
import { NotebookError } from "./errors.ts";
import { itemUrl } from "./library.ts";
import type { Entity } from "./library-schema.ts";
import { listItems } from "./library-store.ts";
import { normalizeText } from "./schema.ts";
export interface LibrarySearch {
  query?: string;
  project?: string;
  topic?: string;
  kind?: string;
  limit?: number;
  offset?: number;
  port?: number;
}
export async function searchLibrary(
  dir: string,
  entity: Entity,
  options: LibrarySearch = {},
) {
  const limit = options.limit ?? 20,
    offset = options.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isInteger(offset) ||
    offset < 0
  )
    throw new NotebookError("USAGE", "invalid search pagination");
  const { items, warnings } = await listItems(dir, entity);
  const terms = normalizeText(options.query ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const candidates = items
    .filter(
      ({ item }) =>
        (!options.project || item.project === options.project) &&
        (!options.topic || item.topics.includes(options.topic)) &&
        (!options.kind ||
          (item.entity === "page" && item.kind === options.kind)),
    )
    .map((loaded) => {
      const { item } = loaded;
      const body =
        item.entity === "page"
          ? sanitizeHtml(loaded.html ?? "", {
              allowedTags: [],
              allowedAttributes: {},
              nonTextTags: ["script", "style", "textarea", "option"],
            }).replace(/&(?:amp|lt|gt);/g, (entity) =>
              entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">",
            )
          : item.template;
      const summary = item.entity === "page" ? item.summary : item.description;
      const title = normalizeText(item.title),
        metadata = normalizeText(
          [summary, item.project, ...item.topics].join(" "),
        ),
        content = normalizeText(body);
      const matches = terms.every(
        (term) =>
          title.includes(term) ||
          metadata.includes(term) ||
          content.includes(term),
      );
      const score = terms.reduce(
        (sum, term) =>
          sum + (title.includes(term) ? 10 : metadata.includes(term) ? 3 : 1),
        0,
      );
      return { matches, score, item, summary };
    })
    .filter((candidate) => candidate.matches)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.updated_at.localeCompare(a.item.updated_at) ||
        a.item.id.localeCompare(b.item.id),
    );
  return {
    total: candidates.length,
    hits: candidates.slice(offset, offset + limit).map(({ item, summary }) => ({
      entity: item.entity,
      id: item.id,
      title: item.title,
      summary,
      project: item.project,
      topics: item.topics,
      ...(item.entity === "page" ? { kind: item.kind } : {}),
      updated_at: item.updated_at,
      url: itemUrl(entity, item.id, options.port),
    })),
    warnings,
  };
}
