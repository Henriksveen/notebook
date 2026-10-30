# HTML report workflow

Read this when the user explicitly asks to save an HTML page or report (interactive or static)
to the notebook. The ground rules in `SKILL.md` still apply: explicit request only, search first.

The design guides in this folder are for the subagent that writes the page. Do not read them
yourself unless you need to check its work.

## 1. Delegate the generation

Generate the HTML in a subagent that runs exactly the model `github-copilot/claude-opus-5.5`,
using the harness's subagent mechanism. Do not write the page yourself. If that model is
unavailable or cannot be selected, STOP and ask the user. Never substitute another model, and
save nothing until the user answers.

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

## 4. Save

Create the Markdown entry (type usually `report`). The body summarizes what the page shows, the
key numbers or findings, and how the data was produced. Then attach the file:

```sh
notebook attach <id> --expected-revision <rev> --file /tmp/<name>.html --name <descriptive-name>.html --json
```

Read the entry, then `update` its body with the revision from `attach`, adding a line near the
top such as `[Open the interactive report](attachment:<attachment-id>)`. Always use the latest
revision from each result.

## 5. Viewer link

Build it from the entry URL the CLI returned: replace `/entries/<id>` with
`/attachments/<id>/<attachment-id>/view`. Do not hard-code the port. Report it alongside the
entry URL, and say that it works only while the local website runs (`notebook open`).

## 6. Regenerate or update

Do not create a new entry. Find and `read` the existing entry, repeat steps 1-3 for the new
file, then attach it to that entry as a NEW attachment with a descriptive name (include a date
or version). `update` the existing entry's body with the revision from `attach` so the link
points at the new attachment, and keep a short line about the earlier version if useful. Never
try to delete or replace files in the notebook directory; older versions remain.

Optionally delete the temporary file after a successful attach.
