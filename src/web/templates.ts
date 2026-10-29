import type { Attachment, Source, Status } from "../schema.ts";
import type { SearchHit, SearchResult } from "../search.ts";
import type { LoadedEntry } from "../store.ts";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export interface Count {
  name: string;
  count: number;
}

export interface SearchForm {
  q: string;
  project: string;
  topic: string;
  type: string;
  status: string;
  includeArchived: boolean;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

export function layout(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Notebook</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body>
<header class="site-header">
<a class="brand" href="/">Notebook</a>
<nav aria-label="Main">
<a href="/">Recent</a>
<a href="/projects">Projects</a>
<a href="/topics">Topics</a>
</nav>
<form class="search" action="/search" method="get" role="search">
<input type="search" name="q" aria-label="Search notebook" placeholder="Search">
<button type="submit">Search</button>
</form>
</header>
<main>
${content}
</main>
<footer class="site-footer">Read-only local view. Not authenticated; reachable only from this machine.</footer>
</body>
</html>
`;
}

export function listPage(heading: string, result: SearchResult): string {
  return `<h1>${escapeHtml(heading)}</h1>
${countLine(result.total)}
${entryList(result.hits)}`;
}

export function countPage(
  heading: string,
  prefix: string,
  counts: readonly Count[],
): string {
  const items = counts
    .map(
      (item) =>
        `<li>${pathLink(prefix, item.name)} <span class="count">${item.count}</span></li>`,
    )
    .join("\n");
  const body =
    counts.length === 0
      ? `<p class="empty">Nothing here yet.</p>`
      : `<ul class="counts">\n${items}\n</ul>`;
  return `<h1>${escapeHtml(heading)}</h1>\n${body}`;
}

export function entryPage(loaded: LoadedEntry, bodyHtml: string): string {
  const { entry } = loaded;
  const archived = entry.status === "archived";
  const banner = archived
    ? `<p class="banner" role="status">Archived${entry.archived_from ? ` (was ${escapeHtml(entry.archived_from)})` : ""}. Hidden from lists and search by default.</p>\n`
    : "";
  const parts = [
    pathLink("/projects/", entry.project),
    escapeHtml(entry.type),
    archived ? "" : statusBadge(entry.status),
    ...entry.topics.map((topic) => pathLink("/topics/", topic)),
    `Created ${dateTime(entry.created_at)}`,
    `Updated ${dateTime(entry.updated_at)}`,
  ].filter((part) => part !== "");
  return `<article>
${banner}<h1>${escapeHtml(entry.title)}</h1>
${metaLine(parts)}
<p class="summary">${escapeHtml(entry.summary)}</p>
<div class="body">${bodyHtml}</div>
${sourcesSection(entry.sources)}${attachmentsSection(entry.id, entry.attachments)}</article>`;
}

export function searchPage(form: SearchForm, result: SearchResult): string {
  const statuses: Status[] = ["draft", "ready", "archived"];
  const options = [
    `<option value=""${form.status === "" ? " selected" : ""}>Any</option>`,
    ...statuses.map(
      (status) =>
        `<option value="${status}"${form.status === status ? " selected" : ""}>${status}</option>`,
    ),
  ].join("");
  return `<h1>Search</h1>
<form class="filters" action="/search" method="get">
<label>Query <input type="search" name="q" value="${escapeHtml(form.q)}"></label>
<label>Project <input type="text" name="project" value="${escapeHtml(form.project)}"></label>
<label>Topic <input type="text" name="topic" value="${escapeHtml(form.topic)}"></label>
<label>Type <input type="text" name="type" value="${escapeHtml(form.type)}"></label>
<label>Status <select name="status">${options}</select></label>
<label class="check"><input type="checkbox" name="include_archived" value="1"${form.includeArchived ? " checked" : ""}> Include archived</label>
<button type="submit">Search</button>
</form>
${countLine(result.total)}
${entryList(result.hits)}`;
}

export function notFoundPage(): string {
  return layout(
    "Not found",
    `<h1>Not found</h1>\n<p>There is nothing at this address.</p>`,
  );
}

export function errorPage(): string {
  return layout(
    "Error",
    `<h1>Something went wrong</h1>\n<p>The page could not be shown.</p>`,
  );
}

function countLine(total: number): string {
  return `<p class="count">${total} ${total === 1 ? "entry" : "entries"}</p>`;
}

function entryList(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return `<p class="empty">No entries.</p>`;
  return `<ul class="entries">\n${hits.map(entryItem).join("\n")}\n</ul>`;
}

function entryItem(hit: SearchHit): string {
  return `<li class="entry">
<h2><a href="/entries/${escapeHtml(hit.id)}">${escapeHtml(hit.title)}</a></h2>
<p class="summary">${escapeHtml(hit.summary)}</p>
${metaLine([
  pathLink("/projects/", hit.project),
  escapeHtml(hit.type),
  statusBadge(hit.status),
  dateTime(hit.updated_at),
])}
</li>`;
}

function metaLine(parts: string[]): string {
  return `<p class="meta">${parts.join(" · ")}</p>`;
}

function statusBadge(status: Status): string {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function dateTime(stamp: string): string {
  return `<time datetime="${escapeHtml(stamp)}">${escapeHtml(stamp.slice(0, 10))}</time>`;
}

function pathLink(prefix: string, name: string): string {
  return `<a href="${escapeHtml(prefix + encodeURIComponent(name))}">${escapeHtml(name)}</a>`;
}

function sourcesSection(sources: readonly Source[]): string {
  if (sources.length === 0) return "";
  const items = sources.map(sourceItem).join("\n");
  return `<section class="sources">\n<h2>Sources</h2>\n<ul>\n${items}\n</ul>\n</section>\n`;
}

function sourceItem(source: Source): string {
  const title = source.title ? `${escapeHtml(source.title)} — ` : "";
  if (source.kind === "url") {
    const label = escapeHtml(source.title ?? source.url);
    return isHttp(source.url)
      ? `<li><a href="${escapeHtml(source.url)}" rel="noopener noreferrer">${label}</a></li>`
      : `<li>${label}</li>`;
  }
  if (source.kind === "repo") {
    const commit = source.commit
      ? ` at <code>${escapeHtml(source.commit)}</code>`
      : "";
    const path = source.path ? ` · ${escapeHtml(source.path)}` : "";
    return `<li>${title}<code>${escapeHtml(source.repo)}</code>${commit}${path}</li>`;
  }
  return `<li>${title}Conversation: ${escapeHtml(source.ref)}</li>`;
}

function isHttp(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function attachmentsSection(
  entryId: string,
  attachments: readonly Attachment[],
): string {
  if (attachments.length === 0) return "";
  const items = attachments
    .map(
      (attachment) =>
        `<li><a href="${escapeHtml(`/attachments/${entryId}/${attachment.id}`)}">${escapeHtml(attachment.filename)}</a> <span class="meta">${escapeHtml(attachment.media_type)}, ${formatSize(attachment.size)}</span></li>`,
    )
    .join("\n");
  return `<section class="attachments">\n<h2>Attachments</h2>\n<ul>\n${items}\n</ul>\n</section>\n`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
