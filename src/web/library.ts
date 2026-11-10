import { readFile } from "node:fs/promises";
import { NotebookError } from "../errors.ts";
import { history } from "../library.ts";
import type { Entity, Page, Prompt } from "../library-schema.ts";
import { listItems, readItem } from "../library-store.ts";
import { REPORT_CSP, REPORT_VIEWER_CSP } from "./security.ts";
import type { Reply } from "./server.ts";
import { escapeHtml as e, layout } from "./templates.ts";

const HTML = "text/html; charset=utf-8";
const SHELL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function page(body: string, headers?: Record<string, string>): Reply {
  return { status: 200, type: HTML, body, headers };
}
export async function libraryRoute(
  root: string,
  url: URL,
): Promise<Reply | undefined> {
  const path = url.pathname;
  if (path === "/static/prompt.js" || path === "/static/list.js")
    return {
      status: 200,
      type: "text/javascript; charset=utf-8",
      body: await readFile(new URL(`.${path.slice(7)}`, import.meta.url)),
    };
  if (path === "/prompts") return promptList(root, url.searchParams.get("q"));
  if (path === "/" || path === "/pages")
    return pageList(root, url.searchParams.get("q"));
  const match =
    /^\/(pages|prompts)\/([^/]+)(?:\/(history|versions)(?:\/([^/]+)(?:\/(content|download))?)?)?$/.exec(
      path,
    );
  if (!match) return undefined;
  const entity: Entity = match[1] === "pages" ? "page" : "prompt",
    id = match[2],
    section = match[3],
    version = match[4],
    mode = match[5];
  if (section === "versions" && !version)
    throw new NotebookError("NOT_FOUND", "version not found");
  if (section === "history") {
    const loaded = await readItem(root, entity, id);
    const versions = await history(root, entity, id);
    return page(
      layout(
        `History: ${loaded.item.title}`,
        `<p><a href="/${match[1]}/${id}">Back to current version</a></p><h1>${e(loaded.item.title)} — history</h1><ol class="history-list">${versions.map((item) => `<li><a href="/${match[1]}/${id}/versions/${item.commit}">${e(item.change_summary)}</a><p class="meta">${e(item.timestamp)} · ${item.commit.slice(0, 8)}</p></li>`).join("")}</ol><p class="meta">Restore a version through Claude/Codex or the notebook CLI.</p>`,
      ),
    );
  }
  const loaded = await readItem(root, entity, id, version);
  const item = loaded.item;
  const base = `/${match[1]}/${id}`,
    pinned = `${base}/versions/${loaded.commit}`;
  if (mode && item.entity !== "page")
    throw new NotebookError("NOT_FOUND", "prompt content route not found");
  if (mode === "content")
    return page(loaded.html ?? "", {
      "Content-Security-Policy": REPORT_CSP,
      "X-Frame-Options": "SAMEORIGIN",
      "Content-Disposition": "inline",
    });
  if (mode === "download")
    return {
      status: 200,
      type: "application/octet-stream",
      body: loaded.html ?? "",
      headers: {
        "Content-Disposition": `attachment; filename="page-${id}.html"`,
      },
    };
  const state = `${version ? "Historical version · " : ""}${item.updated_at.slice(0, 10)}`;
  if (item.entity === "page") {
    return page(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(item.title)} | Notebook</title><link rel="stylesheet" href="/static/style.css"></head><body class="report-viewer"><header class="report-toolbar"><a href="/">Notebook</a><span class="report-name">${e(item.title)} · ${e(state)}</span><a href="${base}/history">History</a>${version ? `<a href="${base}">Current version</a>` : ""}<details class="page-info"><summary>About this page</summary><p>${e(item.summary)}</p><p>${e(item.kind)} · ${e(item.project)}</p>${item.sources.map((source) => (source.kind === "url" ? `<p><a href="${e(source.url)}" rel="noreferrer">${e(source.title ?? source.url)}</a></p>` : `<p>${e(JSON.stringify(source))}</p>`)).join("")}</details><a href="${pinned}/download">Download HTML</a></header><main class="report-main"><iframe src="${pinned}/content" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${e(item.title)}"></iframe></main></body></html>`,
      { "Content-Security-Policy": REPORT_VIEWER_CSP },
    );
  }
  return shellPage(
    item.title,
    `<p class="prompt-back"><a href="/prompts">All prompts</a>${version ? ` · Historical version · <a href="${base}">Current version</a>` : ""}</p><ul class="list-stack prompt-single">${promptBlock(item, base, { open: true, heading: "h1" })}</ul>${item.example ? `<h2>Example</h2><pre class="prompt-example">${e(item.example)}</pre>` : ""}`,
    ["prompt"],
    "/prompts",
  );
}

const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const ICON = (paths: string) =>
  `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${paths}</svg>`;
const COPY_ICON = `${ICON('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6h1.9"/>').replace('class="icon"', 'class="icon icon-copy"')}${ICON('<path d="M3 8.5l3 3 7-7"/>').replace('class="icon"', 'class="icon icon-done"')}`;
const INPUTS_ICON = ICON(
  '<path d="M2 4.5h7M12.5 4.5H14M2 11.5h2M7.5 11.5H14"/><circle cx="10.8" cy="4.5" r="1.6"/><circle cx="5.8" cy="11.5" r="1.6"/>',
);
const HISTORY_ICON = ICON(
  '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
);

function shellPage(
  title: string,
  content: string,
  scripts: string[],
  searchTarget = "",
): Reply {
  const body = layout(title, content, searchTarget).replace(
    "</head>",
    `${scripts.map((name) => `<script src="/static/${name}.js" defer></script>`).join("")}</head>`,
  );
  return page(body, { "Content-Security-Policy": SHELL_CSP });
}

function entryMeta(
  project: string,
  updatedAt: string,
  filterable = true,
): string {
  return `<span class="entry-meta">${filterable ? `<button type="button" class="project" data-filter-value="${e(project)}" title="Show only ${e(project)}">${e(project)}</button>` : `<span class="project">${e(project)}</span>`}<span aria-hidden="true">·</span><time datetime="${e(updatedAt)}">${e(updatedAt.slice(0, 10))}</time></span>`;
}

function historyLink(base: string, title: string): string {
  return `<a class="ghost" href="${base}/history" aria-label="Version history for ${e(title)}" title="History">${HISTORY_ICON}</a>`;
}

function listPage(options: {
  title: string;
  noun: string;
  query: string | null;
  warnings: string[];
  entries: string[];
  empty: string;
  scripts: string[];
}): Reply {
  const { title, noun, entries } = options;
  const count = `${entries.length} ${entries.length === 1 ? noun : `${noun}s`}`;
  return shellPage(
    title,
    `<div class="list-bar"><h1>${title}</h1><span class="count" id="list-count" data-noun="${noun}" aria-live="polite">${count}</span>${entries.length ? `<label class="list-filter"><span class="sr-only">Filter ${noun}s</span><input id="list-filter" type="search" placeholder="Filter…" value="${e(options.query ?? "")}" autocomplete="off" spellcheck="false"></label>` : ""}</div>${options.warnings.length ? `<p class="banner">${e(options.warnings.join("; "))}</p>` : ""}${entries.length ? `<ul class="list-stack">${entries.join("")}</ul><p class="empty" id="list-empty" hidden>No ${noun}s match. <button type="button" class="link-button" id="list-clear">Clear filter</button></p>` : `<p class="empty">${options.empty}</p>`}`,
    options.scripts,
  );
}

const newestFirst = (
  a: { updated_at: string; title: string },
  b: { updated_at: string; title: string },
) => b.updated_at.localeCompare(a.updated_at) || a.title.localeCompare(b.title);

async function pageList(root: string, query: string | null): Promise<Reply> {
  const { items, warnings } = await listItems(root, "page");
  const pages = items
    .map(({ item }) => item)
    .filter((item): item is Page => item.entity === "page")
    .sort(newestFirst);
  return listPage({
    title: "Pages",
    noun: "page",
    query,
    warnings,
    empty: "No pages yet. Ask Claude or Codex to save one.",
    scripts: ["list"],
    entries: pages.map((item) => {
      const base = `/pages/${item.id}`;
      return `<li class="entry page-entry" data-filter-item data-search="${e([item.title, item.summary, item.project, item.kind].join(" "))}"><div class="entry-head"><h2><a class="entry-link" href="${base}">${e(item.title)}</a></h2>${entryMeta(item.project, item.updated_at)}<span class="entry-actions"><span class="kind kind-${item.kind}">${item.kind}</span>${historyLink(base, item.title)}</span></div><p class="entry-desc">${e(item.summary)}</p></li>`;
    }),
  });
}

function previewHtml(item: Prompt): string {
  const values = new Map(item.inputs.map((input) => [input.name, input]));
  let out = "",
    last = 0;
  for (const match of item.template.matchAll(PLACEHOLDER)) {
    out += e(item.template.slice(last, match.index));
    const value = values.get(match[1])?.default;
    out +=
      value === undefined
        ? `<span class="hole">${e(match[0])}</span>`
        : value
          ? `<span class="filled">${e(value)}</span>`
          : "";
    last = match.index + match[0].length;
  }
  return out + e(item.template.slice(last));
}

function promptBlock(
  item: Prompt,
  base: string,
  options: { open?: boolean; heading?: "h1" | "h2" } = {},
): string {
  const heading = options.heading ?? "h2",
    titleId = `title-${item.id}`,
    inputsId = `inputs-${item.id}`,
    missing = item.inputs.filter((input) => input.default === undefined);
  const label = !item.inputs.length
    ? "prompt"
    : missing.length
      ? `needs ${missing.map((input) => input.name).join(", ")}`
      : "ready";
  const title =
    heading === "h1" ? e(item.title) : `<a href="${base}">${e(item.title)}</a>`;
  const inputs = item.inputs.length
    ? `<div class="prompt-inputs" id="${inputsId}" role="group" aria-label="Inputs for ${e(item.title)}"${options.open ? "" : " hidden"}>${item.inputs
        .map(
          (input, index) =>
            `<label><span><b>${e(input.name)}</b>${input.default === undefined ? " · required" : ""}</span><textarea rows="1" data-variable="${e(input.name)}" data-has-default="${input.default !== undefined}" data-default="${e(input.default ?? "")}" placeholder="${e(input.description)}" aria-describedby="${inputsId}-help-${index}" autocomplete="off" spellcheck="false">${e(input.default ?? "")}</textarea><span class="sr-only" id="${inputsId}-help-${index}">${e(input.description)}</span></label>`,
        )
        .join(
          "",
        )}<p class="prompt-note"><span>Values stay in this tab and are not saved.</span><button type="button" class="link-button" data-reset>Reset</button></p></div>`
    : "";
  return `<li class="entry prompt" data-prompt data-filter-item data-template="${e(item.template)}" data-search="${e([item.title, item.description, item.project].join(" "))}"><div class="entry-head"><${heading} id="${titleId}">${title}</${heading}>${entryMeta(item.project, item.updated_at, heading === "h2")}<span class="entry-actions">${item.inputs.length ? `<button type="button" class="ghost" data-toggle-inputs aria-expanded="${options.open ? "true" : "false"}" aria-controls="${inputsId}">${INPUTS_ICON}<span>Customize · ${item.inputs.length}</span></button>` : ""}${historyLink(base, item.title)}</span></div>${item.description ? `<p class="entry-desc">${e(item.description)}</p>` : ""}${inputs}<div class="code-block"><div class="code-top"><span class="code-label">${e(label)}</span><span class="code-status" role="status" aria-live="polite"></span><button type="button" class="copy" aria-label="Copy ${e(item.title)} prompt" title="Copy">${COPY_ICON}</button></div><pre class="prompt-text" tabindex="0" aria-labelledby="${titleId}">${previewHtml(item)}</pre><button type="button" class="prompt-more" hidden aria-expanded="false">Show all</button></div></li>`;
}

async function promptList(root: string, query: string | null): Promise<Reply> {
  const { items, warnings } = await listItems(root, "prompt");
  const prompts = items
    .map(({ item }) => item)
    .filter((item): item is Prompt => item.entity === "prompt")
    .sort(newestFirst);
  return listPage({
    title: "Prompts",
    noun: "prompt",
    query,
    warnings,
    empty: "No prompts yet. Ask Claude or Codex to save one.",
    scripts: ["prompt", "list"],
    entries: prompts.map((item) => promptBlock(item, `/prompts/${item.id}`)),
  });
}
