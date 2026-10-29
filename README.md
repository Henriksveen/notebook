# Notebook

A personal, private, local-first knowledge notebook. Agents save standalone Markdown
entries through a command-line tool, and entries live in a plain git repository you own.
A read-only local website for browsing them is planned (Task 4).

## Requirements

- Node.js 24 or newer (runs TypeScript directly).
- git.
- `flock` (util-linux on Linux; used for the write lock).

## Usage

The launcher is `bin/notebook`. Put it on your PATH or call it by path.

```sh
notebook init                                  # create ~/notebook (or $NOTEBOOK_DIR)
notebook init --remote git@example.com:me/nb.git   # optional: add a backup remote

notebook create --input entry.json             # or --input - to read stdin
notebook search kubernetes --status draft --json
notebook read <id>
notebook update <id> --expected-revision <hash> --input patch.json
notebook ready <id> --expected-revision <hash>
notebook archive <id> --expected-revision <hash>
notebook restore <id> --expected-revision <hash>
notebook attach <id> --expected-revision <hash> --file ./diagram.png --name diagram.png
notebook validate --input entry.json           # check without writing
notebook validate <id>
notebook status
notebook backup                                # retry pushing unpublished commits
```

Global options: `--dir PATH` (or `NOTEBOOK_DIR`), `--json`, `--port N` (or `NOTEBOOK_PORT`,
default `43127`, used only to build entry URLs), `--help`.

There is no delete command. Archive an entry instead.

### Create input

```json
{
  "title": "Standalone descriptive title",
  "summary": "One or two sentences.",
  "project": "Inbox",
  "topics": ["architecture"],
  "type": "research",
  "body": "Markdown body...",
  "sources": [{ "kind": "url", "url": "https://example.com", "title": "Example" }]
}
```

`id`, `status`, timestamps, and `attachments` are managed by the tool and are rejected
if present. Every new entry starts as a draft.

## JSON contract

With `--json`, stdout is exactly one JSON object:

```json
{ "api_version": 1, "ok": true, "data": { "...": "..." }, "backup": { "status": "pending", "reason": "no_remote" }, "warnings": [] }
```

Mutations return `data` with `id`, `title`, `status`, `url`, `revision`, and `commit`.
`backup` is present for mutations and for the `backup` command. Errors:

```json
{ "api_version": 1, "ok": false, "error": { "code": "STALE_REVISION", "message": "...", "details": {} } }
```

Error codes: `USAGE`, `NOT_A_NOTEBOOK`, `NOT_FOUND`, `VALIDATION_FAILED`, `SECRET_DETECTED`,
`STALE_REVISION`, `INVALID_TRANSITION`, `LOCK_TIMEOUT`, `DIRTY_TARGET`, `REPO_STATE`,
`COMMIT_FAILED`, `ATTACHMENT_TOO_LARGE`, `PORT_IN_USE`, `UNSAFE_PATH`, `INTERNAL`.

Exit codes: `0` success (including a backup that is pending or blocked), `1` errors,
`2` usage errors. Without `--json`, results are printed as short text and diagnostics go
to stderr. Set `NOTEBOOK_DEBUG=1` to see stack traces for unexpected errors.

Read the `revision` from `read` (or from a mutation result) and pass it as
`--expected-revision` on the next change. If it no longer matches, you get `STALE_REVISION`
and the current revision in `error.details.current_revision`.

## Data layout

```text
<notebook>/
  README.md
  .gitignore              # ".notebook/"
  entries/<id>.md         # YAML front matter + Markdown body
  attachments/<id>/<attachment-id>.<ext>
  .notebook/              # ignored runtime state (write lock, backup state)
```

Each change is one git commit (`notebook: <action> <id> <title>`) that touches only the
files it wrote. Pushes never force, pull, or rebase.

## Backup

A notebook without a remote keeps everything locally, and mutations report
`backup: pending (no_remote)`. With a remote, each change attempts `git push` (10 s
timeout, no interactive prompts). Failures are reported as `pending` with a reason code
(`push_failed`, `timeout`) and can be retried with `notebook backup`. Before pushing, the
tool scans unpublished commits for secrets and reports `blocked` if it finds any.
Remote URLs and raw git output are never printed.

## Secret detection

Entries and attachments are scanned before they are written. Matches for private keys,
common cloud and service tokens, JWTs, credential assignments, and URLs with embedded
passwords are blocked with `SECRET_DETECTED`. The error names the rule and location
(for example `body:line 12`) but never the matched text.

This is a safeguard, not a guarantee. It cannot find every secret, and binary attachments
are not scanned. There is no bypass flag. Do not rely on it as your only protection.

## Development

```sh
npm test          # node:test suites
npm run typecheck
npm run lint
```

Tests use temporary directories and local bare repositories. They never touch your home
directory, `~/notebook`, or global git configuration.
