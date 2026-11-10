# HTML report workflow

Read this when the user explicitly asks to save an HTML page or report (interactive or static)
to the notebook. The ground rules in `SKILL.md` still apply: explicit request only, search first.

The design guides in this folder are for the subagent that writes the page. Do not read them
yourself unless you need to check its work.

## 1. Delegate the generation

Generate the HTML using the harness's subagent mechanism with either the `claude` provider
(Opus 5.5) or the `codex` provider (an available Codex model). Do not use the GitHub Copilot
provider or write the page yourself. If neither allowed provider and model is available or can
be selected, STOP and ask the user. Save nothing until the user answers.

## 2. Brief the subagent

Pick the design guides for the content, and pass them as absolute paths (this skill's base
directory plus `references/`):

| Content | Guides to pass |
| --- | --- |
| Always | `html-style.md`, `t3-dark.css` |
| Findings, analysis, decisions, summaries | add `html-report.md` |
| Tables, charts, KPIs, filters, comparisons | add `html-data.md` |

The brief must be self-contained:

- The data or content, the purpose, and the audience.
- The guide paths, with the instruction: "Read these files first. Copy `t3-dark.css` verbatim
  into the page's `<style>` and follow the guides."
- The output path: one `.html` file in a temporary directory outside the notebook directory
  (for example `/tmp/<name>.html`).
- Hard constraints (they are also in `html-style.md`): everything inline; no external or relative
  URLs for scripts, stylesheets, images, fonts, or frames; no `fetch`, XHR, WebSocket,
  EventSource, `sendBeacon`; no `eval` or `new Function`; no storage APIs or cookies; no
  submitting forms, dialogs, popups, or navigation; no secrets or unrelated personal data.
- The subagent must NOT run any `notebook` command. It returns only the file path and a
  one-paragraph description.

## 3. Check the file before saving

Confirm that the file exists, ends with `.html`, and is at most 20 MiB. Inspect the source for:

- `<script src`, `<link`, `@import`, `url(` that is not `data:` or `#`, and `src=` or `href=`
  with `http(s)://`, protocol-relative (`//`), or relative paths. Anchor `href`s to external
  sites are acceptable only as plain links the user clicks.
- `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `eval(`,
  `new Function`, `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie`.
- The base stylesheet: the `:root` block from `t3-dark.css` is present (look for
  `--background: #000000` and `--chart-1`).
- Secrets and unrelated personal data.

If you find problems, send them back to the same subagent (same model) to fix. After two failed
rounds, stop and tell the user. This is a practical self-containment check, not a security audit.

## 4. Publish or update a first-class page

Search first with `notebook page search "<concept>" --json`. When updating, read
`notebook page read <id> --json` and supply its current HTML, metadata, relevant
supporting context, revision, and user preservation requirements to the subagent.
Do not generate an update from a summary alone. If several pages match, clarify.

For creation, write a temporary JSON input with `title`, `summary`, `kind`
(`concept` or `report`), optional `project`, `topics`, `sources`, and `context`.
Use real source references. The CLI publishes HTML and its metadata together.

```sh
notebook page create --input /tmp/page.json --html /tmp/page.html --json
```

For updates, pass only changed metadata/context and a required `change_summary`.
Omitted fields are preserved; `context: null` explicitly removes supporting context.
Use the revision from the latest read. Metadata-only updates can omit `--html`.

```sh
notebook page update <id> --expected-revision <revision> --input /tmp/patch.json --html /tmp/page.html --json
```

Preserve existing explanations and working interactions unless the user requests
replacement or redesign. Check a requested example was added and an existing
interaction still works. Reconcile contradictory facts rather than silently
appending them. The CLI cannot prove semantic preservation: inspect the result.
Never silently regenerate a page after a saved prompt changes.

## 5. Report the stable link

Return the `data.url` from the command directly. It stays the same across updates.
Report the change summary and backup status. The link works while the local
website runs (`notebook open`); do not start it unless asked.

## 6. Revisions and recovery

History is available with `notebook page history <id> --json`. Restore only on
request, with `page restore <id> --commit <commit> --expected-revision <current>
--json`. This creates a new revision; never run Git resets or delete old files.

If the CLI reports a recovery conflict, stop and report the affected paths; do
not edit its journal or overwrite possible user changes. Delete temporary output
only after a successful publication. For browsing and history, see
`library-commands.md`.
