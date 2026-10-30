# Notebook v1 — Specification

A personal, private, local-first knowledge notebook. Agents (in T3 Code / OpenCode) save
standalone structured Markdown entries on explicit request through a CLI; a read-only local
website lets the user browse them. This file is the source of truth for implementers.

## Stack and conventions

- TypeScript, ESM, Node >= 24 using native type stripping (run `.ts` directly with `node`).
  Use only erasable TypeScript syntax (no `enum`, no `namespace`, no parameter properties).
  Use explicit `.ts` extensions in relative imports. `tsconfig.json`: `strict`, `noEmit`,
  `allowImportingTsExtensions`, `module`/`moduleResolution` `nodenext`, `verbatimModuleSyntax`,
  `erasableSyntaxOnly` if supported by installed TypeScript.
- Runtime dependencies (only these): `yaml`, `markdown-it`, `sanitize-html`.
- Dev dependencies: `typescript`, `@types/node`, `@types/markdown-it`, `@types/sanitize-html`,
  `@biomejs/biome`.
- No CLI framework, web framework, database, bundler, or frontend JavaScript.
- Tests: `node:test` + `node:assert/strict`, in `test/*.test.ts`.
- npm scripts:
  - `test`: `node --test test/*.test.ts`
  - `typecheck`: `tsc --noEmit`
  - `lint`: `biome check .`
  - `test:e2e`: `node scripts/e2e.ts`
- Tests must never touch the real home directory, `~/notebook`, global git config, or any
  network remote. Use temporary directories under `os.tmpdir()` (or `/tmp/opencode`) and
  local bare repositories. Set git identity per test repository (`git -c user.name=... -c user.email=...`
  or repo-local config), never globally.
- Run all subprocesses with argument arrays (`execFile`/`spawn`), never through a shell.

## Data directory

Resolution order: `--dir PATH` flag, then `NOTEBOOK_DIR` env var, then `~/notebook`.
No per-project notebooks.

```text
<notebook>/
  README.md
  .gitignore              # contains ".notebook/"
  entries/<id>.md
  attachments/<id>/<attachment-id>.<ext>
  .notebook/              # ignored runtime state
    write.lock
    backup-state.json
```

Directory created with mode 0700. File/attachment names never change when metadata changes.

## Entry format

UTF-8 Markdown file with YAML front matter delimited by `---` lines.

```yaml
---
schema_version: 1
id: "<uuid v4>"
title: "Standalone descriptive title"
summary: "One or two sentences."
project: "Inbox"
topics: ["architecture"]
type: "research"
created_at: "2026-10-29T12:00:00.000Z"
updated_at: "2026-10-29T12:00:00.000Z"
status: "draft"
archived_from: "draft"        # only present while archived
sources: []
attachments: []
---
Markdown body...
```

Rules:
- `id`: `crypto.randomUUID()`; immutable. `created_at` immutable. Both ISO-8601 UTC.
- `title`: 1..200 chars, single line. `summary`: 1..500 chars, single line.
- `project`: 1..80 chars, single line; default `"Inbox"` if missing/blank.
- `topics`: array of 0..20 strings, each normalized to lowercase slug `[a-z0-9]+(-[a-z0-9]+)*`,
  max 50 chars, deduplicated, sorted.
- `type`: lowercase slug (same pattern). Suggested values (not enforced): research, idea,
  report, summary, bug-list, decision, how-to, note.
- `status`: `draft | ready | archived`. Create always yields `draft`. `archived_from` is
  present iff status is `archived` and holds `draft` or `ready`.
- `sources`: array of objects, each one of:
  - `{ kind: "url", url: "https://...", title?: string }` (http/https only)
  - `{ kind: "repo", repo: string, commit?: string, path?: string, title?: string }`
  - `{ kind: "conversation", ref: string, title?: string }`
- `attachments`: array of `{ id, filename, stored_as, media_type, size, sha256 }` where
  `stored_as` is `<attachment-id>.<ext>` and `filename` is the original basename.
- Unknown front matter keys are a validation error.
- YAML parsing must be strict: reject duplicate keys, aliases/anchors, custom tags; cap front
  matter size (64 KiB) and entry size (2 MiB).
- Serialization must be deterministic (stable key order as listed above) so read → write
  round-trips byte-identically.
- `revision` = SHA-256 hex of the entry file's exact bytes (attachment metadata lives in front
  matter, so adding an attachment changes the revision).

## Search

Shared module used by CLI and website. Normalize with NFKC + case-fold (toLowerCase). Query
split on whitespace; every term must appear (substring) in title, summary, or body. Filters:
project (exact, case-insensitive), topic, type, status. Archived entries excluded unless
`includeArchived` or `status: "archived"` filter. Ranking: title matches > summary matches >
body matches, then `updated_at` desc. Empty query returns all matching filters sorted by
`updated_at` desc. Support `limit` (default 20, max 200) and `offset`. Results include id,
title, summary, project, topics, type, status, updated_at, url. Scan files per call; no index.

## Path safety

Entry IDs must match the UUID pattern before touching the filesystem. Reject symlinks for
entry files, attachment files, and the entries/attachments directories. All resolved paths
must remain inside the data root.

## Writes (transaction)

Every mutating operation:
1. Acquire an exclusive lock on `.notebook/write.lock` using the system `flock` binary
   (e.g. spawn `flock --exclusive --timeout <s> <lockfile> <node> <helper>` or hold the lock via
   a long-lived `flock` child on an fd). Never delete the lock file. Timeout → `LOCK_TIMEOUT`.
   Implementation may choose any approach that is a real kernel-level `flock` and is tested
   with concurrent processes.
2. Verify the repo: is a git repo, not mid-merge/rebase, not detached HEAD.
3. Reject if any target path has uncommitted changes (`DIRTY_TARGET`). Unrelated working tree
   changes and staged changes elsewhere must be preserved and must not be included in commits.
4. For updates: compare `--expected-revision` with the current revision inside the lock;
   mismatch → `STALE_REVISION`, no changes.
5. Validate; scan for secrets (below) → `SECRET_DETECTED`, no changes.
6. Write files via temp file in same directory + fsync + atomic rename.
7. `git add -- <exact paths>` then `git commit --only --no-verify -m "<message>" -- <exact paths>`
   (use literal pathspecs, e.g. `GIT_LITERAL_PATHSPECS=1`). Commit message:
   `notebook: <action> <id> <title>`.
8. Attempt `git push` (no force, no pull/merge/rebase), non-interactive
   (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` unset/empty, `-c core.askPass=`), timeout 10 s.
   Before pushing, scan unpublished commits' changed notebook files for secrets; if found,
   skip push and report backup `blocked` with reason `secret_in_unpublished_commit`.
9. Backup result: `{ status: "pushed" | "pending" | "blocked", reason?: "no_remote" | "push_failed" | "timeout" | "secret_in_unpublished_commit" }`.
   Record last result in `.notebook/backup-state.json`. Never print remote URLs or raw git
   stderr (credentials may appear); map to reason codes.
10. If the commit fails after files were written, return `COMMIT_FAILED` with the affected
    paths and recovery instructions; do not delete or revert files.

Pre-flight on every mutation: if any `entries/` or `attachments/` path is dirty or untracked
from an earlier interrupted operation, refuse with `DIRTY_TARGET` only when it is a path the
operation would touch; other notebook paths produce a warning in the result.

## Secret detection

Block (with rule id and location like `body:line 12`, `frontmatter:title`, `attachment:<name>`,
never the matched text) on:
- PEM private keys (`-----BEGIN ... PRIVATE KEY-----`, OpenSSH private keys).
- AWS access key IDs (`AKIA`/`ASIA` + 16 uppercase alnum), GitHub tokens (`ghp_`, `gho_`,
  `ghu_`, `ghs_`, `ghr_`, `github_pat_`), Slack tokens (`xox[abprs]-`), OpenAI-style `sk-`
  keys (>= 20 chars after prefix), Anthropic `sk-ant-`, Google API keys (`AIza` + 35),
  Stripe `sk_live_`/`rk_live_`, JWTs (three base64url segments starting `eyJ`).
- Credential assignments: `(password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?<value>`
  where value is >= 8 non-space chars and not an obvious placeholder (`<...>`, `${...}`,
  `xxx...`, `***`, `changeme`, `example`, `your_...`).
- URLs with embedded credentials (`scheme://user:pass@host`).
Scan front matter values, body, attachment original filenames, and attachment bytes when the
attachment is text-like (decode as UTF-8 if valid) — binary files are not scanned (documented).
No bypass flag.

## CLI

Binary: `bin/notebook` (POSIX sh launcher that execs `node <repo>/src/cli.ts "$@"`, resolving its
own real path). Global flags: `--dir PATH`, `--json`. Without `--json`, print concise human text.

Commands:
- `init [--remote URL]` — create data dir (0700), `git init -b main`, write README.md and
  .gitignore, initial commit, optionally `git remote add origin URL`. Refuse if dir is non-empty
  and not already a notebook.
- `create --input FILE|-` — JSON `{ title, summary, project?, topics?, type, body, sources? }`.
  Ignores/rejects `id`, `status`, timestamps, `attachments` from input. Always draft.
- `validate (--input FILE|- | ID)` — no mutation.
- `search [QUERY...] [--project X] [--topic X] [--type X] [--status X] [--include-archived] [--limit N] [--offset N]`
- `read ID` — full entry + revision + url.
- `update ID --expected-revision HASH --input FILE|-` — partial: any of title, summary,
  project, topics, type, body, sources. Cannot change id/created_at/status/attachments.
- `ready ID --expected-revision HASH` — draft → ready (archived → error `INVALID_TRANSITION`).
- `archive ID --expected-revision HASH` — sets archived, records archived_from.
- `restore ID --expected-revision HASH` — archived → archived_from.
- `attach ID --expected-revision HASH --file PATH [--name NAME]` — copy (never move) file;
  max 20 MiB (`ATTACHMENT_TOO_LARGE`); compute sha256, media type from extension; reject
  symlinks / non-regular files. Only `.html` files get the HTML report treatment (`text/html`);
  `.htm` is not recognized.
- `status` — repo ok, head commit, remote configured (yes/no, never URL), last backup result,
  count of unpublished commits.
- `backup` — retry push only.
- `open [ID] [--no-browser] [--port N]` — start or reuse website, print URL, open browser with
  `xdg-open` (no shell); browser failure still succeeds with URL.
- `serve [--port N]` — foreground server.
No `delete` command.

JSON output: exactly one object on stdout:
```json
{ "api_version": 1, "ok": true, "data": { ... }, "backup": { "status": "pending", "reason": "no_remote" }, "warnings": [] }
```
Errors: `{ "api_version": 1, "ok": false, "error": { "code": "STALE_REVISION", "message": "...", "details": { ... } } }`.
Codes: `USAGE`, `NOT_A_NOTEBOOK`, `NOT_FOUND`, `VALIDATION_FAILED`, `SECRET_DETECTED`,
`STALE_REVISION`, `INVALID_TRANSITION`, `LOCK_TIMEOUT`, `DIRTY_TARGET`, `REPO_STATE`,
`COMMIT_FAILED`, `ATTACHMENT_TOO_LARGE`, `PORT_IN_USE`, `UNSAFE_PATH`, `INTERNAL`.
Exit 0 on success (including backup pending/blocked); exit 1 on errors; exit 2 on usage errors.
Mutation results include `id, title, status, url, revision, commit`.

Entry URL: `http://127.0.0.1:<port>/entries/<id>`, default port 43127, overridable with
`NOTEBOOK_PORT` or `--port`.

## Website (read-only)

`node:http`, bound to `127.0.0.1` only. Server-rendered HTML + one static CSS file. No JS on
Notebook pages (report scripts run only inside the sandboxed report frame; see the viewer routes).
Routes (GET/HEAD only; others 405):
- `/` recent non-archived entries (title, summary, project, type, status, date).
- `/entries/<id>` article: title, metadata, summary, rendered body, sources, attachments.
  Archived entries reachable with a visible "Archived" banner.
- `/projects`, `/projects/<encoded>`; `/topics`, `/topics/<encoded>`.
- `/search?q=&project=&topic=&type=&status=&include_archived=1`.
- `/attachments/<entry-id>/<attachment-id>` — raster images (png/jpeg/gif/webp) inline with
  their media type; everything else (including html, svg, pdf) with
  `Content-Disposition: attachment` and `application/octet-stream`.
- `/attachments/<entry-id>/<attachment-id>/view` — report viewer for `text/html` attachments only
  (404 otherwise): full-width Notebook page with toolbar (home link, filename, "Back to entry",
  "Download HTML") and an `<iframe sandbox="allow-scripts">` (no `allow-same-origin`,
  `referrerpolicy="no-referrer"`) pointing at `/content`. No JS of its own. CSP
  `default-src 'none'; style-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  `X-Frame-Options: DENY`.
- `/attachments/<entry-id>/<attachment-id>/content` — raw HTML bytes as `text/html; charset=utf-8`,
  `Content-Disposition: inline`, for `text/html` attachments only (404 otherwise). CSP
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN` (so the viewer can frame it). The sandbox in the header also
  applies when the URL is opened directly.
- `/static/style.css`.
- `/_health` → JSON `{ app: "notebook", api_version: 1, fingerprint }` where fingerprint is
  sha256 of the canonical (realpath) data dir.
Security:
- Reject requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` (421/400).
- Headers on every response: `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`.
  The report routes override `Content-Security-Policy` and `X-Frame-Options` (see the viewer
  routes above); all other headers still apply.
- Markdown: `markdown-it` with `html: false`, `linkify: true`; then `sanitize-html` allowlist
  (headings, p, lists, code/pre, blockquote, tables, a[href], img[src,alt], em/strong/del, hr, br);
  allowed schemes http/https/mailto for links; images only relative `/attachments/...` paths
  (agents reference attachments as `attachment:<attachment-id>` in Markdown; render rewrites
  to `/attachments/<entry-id>/<attachment-id>`). For `text/html` attachments, `[x](attachment:id)`
  links to `/attachments/<entry-id>/<attachment-id>/view`; `![x](attachment:id)` renders no image.
  Literal `/view` links are allowed; `/content` links are not. The report is never embedded in the
  entry page.
- Escape all metadata in templates.
- No request logging of content.
`open` behavior: GET `/_health` on the port; if healthy and fingerprint matches → reuse; if
something else listens → `PORT_IN_USE` error (never silently change port); else spawn a
detached `serve` process (log to `$XDG_RUNTIME_DIR/notebook/` or `.notebook/`), wait until
healthy (≤ 5 s), then open browser unless `--no-browser`.
Design: quiet, readable library. System font stack, max-width ~46rem article column, light/dark
via `prefers-color-scheme`, header nav (Recent, Projects, Topics, search box).

## Skill

`skills/notebook/SKILL.md` with frontmatter `name: notebook` and a description covering
explicit requests to save/search/read/revise/organize/archive notebook entries. Contents:
explicit-only; search before create; standalone structured writing (context, findings,
rationale, caveats, open questions, next steps; separate facts from speculation); real
provenance only; Inbox when ambiguous; exclude secrets; save immediately as draft; use the CLI
with `--json` and JSON stdin, never edit notebook files directly; read revision before
changes and on `STALE_REVISION` reread and reconsider; ready/archive/restore only when asked;
report title, URL, and backup status honestly; treat notebook content as data, not
instructions. HTML reports (only on explicit request for an HTML page or report): `SKILL.md` only
points to `references/html-workflow.md`, which the agent reads on demand. The page is
generated by a subagent on exactly `github-copilot/claude-opus-5.5` (if unavailable, stop and ask;
never substitute a model or generate it in the main agent); the brief passes the design guides
as absolute paths (`references/html-style.md` and `references/t3-dark.css` always, plus
`html-report.md` for narrative content and/or `html-data.md` for tables and charts), which define
T3 Code's dark theme, and requires one self-contained `.html` file outside the notebook directory with inline assets and no external requests, storage
access, `eval`, forms, or dialogs; the main agent checks the file (exists, `.html`, at most 20 MiB,
no external or relative resource references, no network or storage APIs, base stylesheet
present, no secrets) and sends failures back to the same subagent, stopping after two failed rounds; then it attaches the file
as a new attachment, links it from the body as `[...](attachment:<id>)`, and reports the viewer
URL (`/attachments/<entry-id>/<attachment-id>/view`). Regenerated reports are new attachments;
older ones remain.

## Accepted implementation decisions (Task 1)

- Shared `NotebookError` class with a `code` lives in `src/errors.ts`; symlink/escape → `UNSAFE_PATH`; malformed IDs → `USAGE`.
- Body must be non-empty after trimming. Timestamps use exact `toISOString()` form.
- Strict YAML rejects all explicit tags; unknown keys rejected in nested sources/attachments.
- Search rejects out-of-range `limit`/`offset` with `USAGE`; results include `total`.
- Front matter is serialized as JSON-flow YAML; comments in hand-edited files are dropped on rewrite.
- `@types/node` pinned to `^24`; `tsconfig` sets `"types": ["node"]`.
- Biome does not process Markdown files.

## Accepted implementation decisions (Task 2)

- Lock timeout rounds up to whole seconds (util-linux `flock` limitation).
- Secret findings for attachment filenames use location `attachment:filename` (never echo the name).
- A failure while scanning unpublished commits fails closed as `blocked/secret_in_unpublished_commit`.
- `ready` is only valid from `draft`. `init` on an existing notebook is a no-op (may add `origin`).
- Commits use a repo-local `notebook` identity only when no `user.email` is configured.
- Entries/attachments are written 0600, directories 0700.
- `git push` runs in its own process group with stdio ignored and `GIT_SSH_COMMAND` defaulting to
  `ssh -o BatchMode=yes`; on timeout the whole group is killed.

## Accepted implementation decisions (Task 3)

- Topic and type inputs are normalized (diacritics stripped, lowercase, non-alphanumeric runs →
  `-`, trimmed); only values that normalize to an empty or over-long slug are rejected. Search
  topic/type filters use the same normalization.
- `read`, `search`, and `validate ID` fail with `NOT_A_NOTEBOOK` if the directory is not a
  notebook. `status` stays diagnostic (`repo_ok: false`) instead of failing.
- `backup` returns `data: {}` with the result in the top-level `backup` field.
- `validate` also runs the secret scan.
- Argument-parse errors use fixed messages (Node's raw messages may echo values).

## Accepted implementation decisions (Task 4)

- Every response also sends `Cache-Control: no-store`.
- Web lists are capped (home 50, other lists 200) without pagination.
- Unknown project/topic pages return 200 with an empty list; invalid `status` on `/search` is ignored.
- Attachments of archived entries are still served (their entry pages remain reachable), including
  the report viewer and content routes.
- Disallowed links/images keep their text/alt but lose `href`/`src`.
- `npm test` runs with `--test-concurrency=4` to avoid git/process contention.

## Accepted implementation decisions (review fixes)

- `init` also writes `.notebook-format` (`notebook-format 1`) next to README and `.gitignore`. A notebook is a git top level with that marker and a `.gitignore` line `.notebook/`. A non-empty directory without the marker is refused with `NOT_A_NOTEBOOK` and never adopted.
- Pushes use an explicit, non-forced refspec `HEAD:refs/heads/<branch>` with `--no-follow-tags`, so `remote.origin.push` refspecs and `push.followTags` are ignored. A mirror remote (`remote.origin.mirror=true`) is not pushed to (`push_failed`). A detached HEAD is refused.
- The pre-push secret scan covers commits not reachable from `refs/remotes/origin/<branch>` (all commits when that ref is missing). Merge commits scan their whole `entries/` and `attachments/` trees. Any failure to enumerate commits or read blobs blocks the push.
- A committed save never fails because backup state cannot be written: the result stays successful and carries the warning "could not record backup state". `status` reports `unpublished_commits: null` with a warning when commits cannot be listed.
- Unknown field names, unknown commands, and unknown options are never echoed. Errors use fixed text, and unknown fields are reported as `<unknown field #N>`.
- Credential assignments may span whitespace and newlines (up to 64 characters of separator whitespace on each side). URL-credential, JWT, and the other rules run in linear time on adversarial input.
- A health probe gives up after 1 s of wall-clock time or 4 KiB of body. The `open` startup wait is bounded to 5 s.
- Human-mode failures print the `paths` and `recovery` details (`COMMIT_FAILED`, `DIRTY_TARGET`).

## Install script

`scripts/install.sh` — opt-in, run by the user. Links `~/.local/bin/notebook` → repo
`bin/notebook`, copies the skill (`SKILL.md` and `references/*`) to
`~/.config/opencode/skills/notebook/`, runs `notebook init`
if `~/notebook` doesn't exist. Refuses to overwrite existing different files. Never edits
shell profiles or OpenCode config. Supports `--dry-run`.
