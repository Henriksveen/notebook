# Notebook

A personal, private, local-first knowledge notebook. Agents save standalone Markdown
entries through a command-line tool on your explicit request, and the entries live in a plain
git repository that you own. A read-only local website lets you browse them (see [Website](#website)).

Nothing is captured automatically. An agent saves, searches, or changes an entry only when you
ask it to.

## Requirements

- Node.js 24 or newer (the tool runs its TypeScript sources directly).
- git.
- `flock` (util-linux on Linux; used for the write lock).
- `xdg-open` if you want `notebook open` to launch your browser. Without it the URL is printed.

## Install

From a checkout of this repository:

```sh
scripts/install.sh --dry-run    # print what would happen; changes nothing
scripts/install.sh              # install
```

The installer is opt-in and does exactly this:

- Links `~/.local/bin/notebook` to `bin/notebook` in this checkout.
- Copies `skills/notebook/SKILL.md` to `~/.config/opencode/skills/notebook/SKILL.md`, so your
  OpenCode and T3 Code agents can use the skill.
- Runs `notebook init` to create `~/notebook` (or `$NOTEBOOK_DIR`) if that directory does not exist.

It never edits shell profiles or OpenCode configuration, and it never passes a remote to `init`.
It checks Node, git, and flock before it changes anything. It refuses to overwrite a different
existing file, and running it again is safe: an installed copy is reported as `already installed`.

If `~/.local/bin` is not on your `PATH`, add it in your shell profile yourself.

After installing, **restart your agent session** (OpenCode or T3 Code) so it discovers the skill.

### Upgrading the skill

The installer refuses to replace a differing skill file. After you update `skills/notebook/SKILL.md`
in the checkout, remove the installed copy and run the installer again:

```sh
rm ~/.config/opencode/skills/notebook/SKILL.md
scripts/install.sh
```

### Adding a private backup remote

A notebook without a remote keeps everything on your machine, and every change reports
`backup pending (no_remote)`. To back it up, create an **empty private** repository (for example on
GitHub, without a README or license), then:

```sh
git -C ~/notebook remote add origin git@github.com:<you>/<private-repo>.git
notebook backup
```

Use a private repository only; entries can contain personal notes. Pushes never prompt for
credentials (`GIT_TERMINAL_PROMPT=0`, no askpass, 10 s timeout), so the remote must already work
non-interactively, for example with an SSH key that needs no passphrase prompt or with a stored
HTTPS credential. A push only sends the current branch to `refs/heads/<branch>` on `origin`, never
forces, and ignores any extra `remote.origin.push` refspecs; a mirror remote (`remote.origin.mirror`)
is not pushed to.

You can also set the remote when creating the notebook: `notebook init --remote <url>`.

### Manual uninstall

The tool has no uninstall script. To remove it:

```sh
rm ~/.local/bin/notebook                              # only if it is the link created by the installer
rm -r ~/.config/opencode/skills/notebook              # the installed skill
pgrep -af "cli.ts serve"                              # find a running website, then stop it with kill <pid>
```

Your entries stay in `~/notebook` until you delete that directory yourself. Remove the `PATH`
line from your shell profile only if you added one. You can delete the checkout when you no
longer need it.

## Everyday use

### From an agent

Ask in plain language. The skill runs only for explicit requests:

- "Save this to my notebook as a research note." The agent searches for related entries first,
  saves a draft, and reports the title, URL, status, and backup status.
- "Search my notebook for ingress timeouts."
- "Update the notebook entry `<id>` with the new findings."
- "Mark that entry ready." / "Archive it." / "Restore it."
- "Attach this diagram to the notebook entry."
- "Open my notebook entry for the deploy plan." (opens the browser)

Agents save entries as drafts immediately and do not ask for a second confirmation.

### From the shell

```sh
notebook init                                     # create ~/notebook (or $NOTEBOOK_DIR)
notebook create --input entry.json                # or --input - to read JSON from stdin
notebook search kubernetes --status draft
notebook read <id>
notebook status
notebook backup
notebook open                                     # website home page in your browser
```

Use `notebook --help` for the full usage text.

## Command reference

Global options (accepted by every command):

| Option | Meaning |
| --- | --- |
| `--dir PATH` | Notebook directory. Default: `$NOTEBOOK_DIR`, then `~/notebook`. |
| `--json` | Print exactly one JSON object on stdout. |
| `--port N` | Port used in entry URLs and by the website. Default: `$NOTEBOOK_PORT`, then `43127`. |
| `--help`, `-h` | Show usage. |

| Command | Purpose |
| --- | --- |
| `init [--remote URL]` | Create the notebook (mode 0700, `git init -b main`, README, `.gitignore`, `.notebook-format` marker, first commit). It refuses a non-empty directory that is not already a notebook, so an existing repository is never adopted. If the notebook already exists, it is left in place and `--remote` only adds `origin` when none is set. |
| `create --input FILE\|-` | Save a new draft from JSON. |
| `validate (--input FILE\|- \| ID)` | Check a payload or a saved entry without changing anything. |
| `search [QUERY...] [--project X] [--topic X] [--type X] [--status X] [--include-archived] [--limit N] [--offset N]` | Search entries. Archived entries are excluded unless requested. |
| `read ID` | Show an entry with its body, revision, URL, and attachments. |
| `update ID --expected-revision HASH --input FILE\|-` | Change any of `title`, `summary`, `project`, `topics`, `type`, `body`, `sources`. |
| `ready ID --expected-revision HASH` | Draft → ready. |
| `archive ID --expected-revision HASH` | Draft or ready → archived. |
| `restore ID --expected-revision HASH` | Archived → the status it had before. |
| `attach ID --expected-revision HASH --file PATH [--name NAME]` | Copy a file into the entry (max 20 MiB; symlinks and non-regular files are refused). |
| `status` | Repository state, remote configured (yes/no, never the URL), unpublished commits, last backup result. |
| `backup` | Retry pushing unpublished commits. |
| `open [ID] [--no-browser]` | Start the website if needed, or reuse it, then open the home page or an entry. |
| `serve` | Run the website in the foreground until Ctrl+C. |

There is no delete command. Archive an entry instead (see [Archive instead of delete](#archive-instead-of-delete)).

## Entry format

Each entry is `entries/<id>.md`: YAML front matter between `---` lines, then a Markdown body.

```yaml
---
schema_version: 1
id: "3f2b8c1e-9d4a-4b7e-8f1a-2c3d4e5f6a7b"
title: "Standalone descriptive title"
summary: "One or two sentences."
project: "Inbox"
topics: ["architecture"]
type: "research"
created_at: "2026-10-29T12:00:00.000Z"
updated_at: "2026-10-29T12:00:00.000Z"
status: "draft"
sources: []
attachments: []
---
Markdown body...
```

Rules:

- `title` is 1-200 characters on one line; `summary` is 1-500 characters on one line.
- `project` defaults to `Inbox` when missing or blank (1-80 characters).
- `topics` are lowercase slugs (`[a-z0-9]+(-[a-z0-9]+)*`), at most 20, deduplicated, and sorted.
  The tool normalizes what you type (diacritics removed, lowercase, punctuation becomes `-`).
- `type` is a lowercase slug. Suggested values: `research`, `idea`, `report`, `summary`,
  `bug-list`, `decision`, `how-to`, `note`. Other slugs are accepted.
- `status` is `draft`, `ready`, or `archived`. Every new entry starts as `draft`. `archived_from`
  appears only while an entry is archived.
- `sources` are real provenance only: `{"kind": "url", "url": "https://..."}`,
  `{"kind": "repo", "repo": "owner/name", "commit": "<sha>", "path": "src/x.ts"}`, or
  `{"kind": "conversation", "ref": "..."}`.
- `attachments` are managed by the tool. Files are stored as
  `attachments/<id>/<attachment-id>.<ext>`.
- `id`, `created_at`, and the storage file name never change. Unknown keys are rejected.
- The body must not be empty. Front matter is capped at 64 KiB and an entry at 2 MiB.
- `revision` is the SHA-256 of the entry file's exact bytes. Pass it as `--expected-revision`
  on every change.

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

`id`, `status`, timestamps, and `attachments` are managed by the tool and are rejected if present.

### Attachments in the body

After `attach`, refer to a file from the Markdown body as `attachment:<attachment-id>`. The
attachment id is listed under `attachments` in `notebook read <id> --json`:

```markdown
![pixel](attachment:6c1f0d3e-...)
[report](attachment:0a9b8c7d-...)
```

The website rewrites these to its own attachment URLs. Only the entry's own attachments can be linked.

## JSON contract

With `--json`, stdout is exactly one JSON object:

```json
{ "api_version": 1, "ok": true, "data": { "...": "..." }, "backup": { "status": "pending", "reason": "no_remote" }, "warnings": [] }
```

Mutations return `data` with `id`, `title`, `status`, `url`, `revision`, and `commit`. The
`backup` field is present for mutations and for the `backup` command. Errors look like this:

```json
{ "api_version": 1, "ok": false, "error": { "code": "STALE_REVISION", "message": "...", "details": { "current_revision": "..." } } }
```

Error codes: `USAGE`, `NOT_A_NOTEBOOK`, `NOT_FOUND`, `VALIDATION_FAILED`, `SECRET_DETECTED`,
`STALE_REVISION`, `INVALID_TRANSITION`, `LOCK_TIMEOUT`, `DIRTY_TARGET`, `REPO_STATE`,
`COMMIT_FAILED`, `ATTACHMENT_TOO_LARGE`, `PORT_IN_USE`, `UNSAFE_PATH`, `INTERNAL`.

Exit codes: `0` success (including a backup that is pending or blocked), `1` errors, `2` usage
errors. Without `--json`, results are printed as short text and diagnostics go to stderr. Set
`NOTEBOOK_DEBUG=1` to see stack traces for unexpected errors.

On `STALE_REVISION`, read the entry again and reconsider the change; do not retry the old change
with the new revision blindly.

## Backup and conflicts

Each change is one git commit (`notebook: <action> <id> <title>`) that touches only the files it
wrote. Commits are never pushed with force, and the tool never pulls, merges, or rebases.

After a change, the tool tries `git push` with a 10-second timeout and no prompts:

- `backup: pushed`. Everything is on the remote.
- `backup: pending (no_remote)`. No remote is configured yet. Changes stay local.
- `backup: pending (push_failed)` or `(timeout)`. The push did not complete. Run `notebook backup`
  once the cause is fixed (network, credentials, remote path).
- `backup: blocked (secret_in_unpublished_commit)`. A secret was found in commits that have not been
  pushed, so nothing is pushed. See [Blocked backups](#blocked-backups).

Remote URLs and raw git output are never printed. `notebook status` shows whether a remote is
configured and how many commits are unpublished.

### Diverged remote

If the remote has commits you do not have locally (for example you pushed from another machine),
the push is rejected and reported as `pending (push_failed)`. The tool will not force it. Resolve it
yourself, with no write operation running:

```sh
git -C ~/notebook fetch origin
git -C ~/notebook log --oneline --left-right HEAD...origin/main   # what differs
git -C ~/notebook merge origin/main                                 # or rebase, your choice
```

Resolve any conflicts in `entries/` by hand, then check the changed entries and retry:

```sh
notebook validate <id>
notebook backup
```

Do not leave a merge or rebase half-finished: the tool refuses to write while the repository is
mid-merge or mid-rebase (`REPO_STATE`).

### Blocked backups

`backup: blocked (secret_in_unpublished_commit)` means an unpublished commit contains a secret. The
secret is still in local history, and the tool will not push it. Remove the secret from the entry
with `notebook update`, then rewrite the unpublished commits with git yourself (for example
`git -C ~/notebook rebase -i origin/main`, or reset the unpublished commits and recommit). Then run
`notebook backup`.

If a secret was already pushed, treat it as leaked: revoke or rotate it. Removing it from remote
history needs a force push, which you must do manually outside this tool.

## Concurrency

Every write takes an exclusive `flock` on `.notebook/write.lock`. Several agents or shells can save
at the same time, and writes are serialized. If another write holds the lock for more than about
10 seconds, the command fails with `LOCK_TIMEOUT`; retry once. Reads and searches do not take the lock.

Updates are checked against the revision inside the lock, so two agents cannot silently overwrite
each other: the second one gets `STALE_REVISION`.

## Data layout

```text
<notebook>/
  README.md
  .gitignore              # ".notebook/"
  .notebook-format        # "notebook-format 1" marker; the CLI only works on notebooks that have it
  entries/<id>.md         # YAML front matter + Markdown body
  attachments/<id>/<attachment-id>.<ext>
  .notebook/              # ignored runtime state (write lock, backup state, website log)
```

The notebook directory is created with mode 0700; entries and attachments are written with mode 0600.
Agents never run git inside the notebook. You may use git there yourself for the manual steps described below.

## Secret detection

Entries and attachments are scanned before they are written. Matches for private keys, common
cloud and service tokens (AWS, GitHub, Slack, OpenAI and Anthropic keys, Google and Stripe keys),
JWTs, credential assignments (`password=...`, `api_key: ...`), and URLs with embedded passwords are
blocked with `SECRET_DETECTED`. The error names the rule and location (for example `body:line 12`)
but never the matched text. Unpublished commits are scanned again before any push.

This is a safeguard, not a guarantee:

- It cannot find every secret, and it will miss secrets in forms it does not know.
- Binary attachments (images, PDFs, archives) are not scanned. Check them yourself before attaching.
- There is no bypass flag, by design.
- Once a commit is pushed, git history keeps the content. Removing it later is manual, forceful
  work and does not reach clones or copies that already exist.

## Archive instead of delete

Entries are never deleted by the tool. `archive` hides an entry from the home page, projects,
topics, and default search, and keeps its content and attachments; `restore` brings it back.

Deleting an entry for real is manual git work: remove the entry file and its attachment folder,
commit, and push. The entry stays in git history, and removing it from history means rewriting it
and force-pushing, which you do by hand outside this tool. Clones made before that keep their copies.

## Website

`notebook open [ID] [--no-browser]` starts the local website if it is not running, or reuses it, and
then opens the home page (or the entry page when an ID is given) with `xdg-open`. It prints the URL in
any case. `notebook serve` runs the same website in the foreground until Ctrl+C.

The default port is `43127` (`--port N` or `NOTEBOOK_PORT`). The tool never silently changes
port: if another program holds it, you get `PORT_IN_USE`. A website started by `open` writes its
output to `.notebook/server.log` inside the notebook.

- The entry URL is `http://127.0.0.1:<port>/entries/<id>`. It works only while the website runs.
  Agents report the URL and remind you to run `notebook open` if you need it live.
- The server listens on `127.0.0.1` only and answers `GET` and `HEAD`; other methods get `405`.
  Requests must use a `Host` of `127.0.0.1:<port>` or `localhost:<port>`; anything else gets `421`.
- It is read-only: it lists, searches, and shows entries, and downloads attachments.
  Attachments are served only when the entry lists them. Raster images (PNG, JPEG, GIF, WebP) are
  shown inline. Everything else, including HTML and SVG, is downloaded as `application/octet-stream`.
- Archived entries are hidden from the home page, projects, topics, and search. Search includes them
  with `include_archived=1` or `status=archived`. An archived entry is still reachable at
  `/entries/<id>`, with an "Archived" banner.
- Markdown is rendered without raw HTML. Links are limited to `http`, `https`, `mailto`, and the
  entry's own attachments. Images may only come from the entry's own attachments.
- Pages use no JavaScript. Every response sends a restrictive Content-Security-Policy, `nosniff`,
  `no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store`.

**Localhost is not authentication.** Any program or user account on this machine that can reach
`127.0.0.1` can read the notebook through the website while it runs. Stop `serve` with Ctrl+C.
A website started by `open` keeps running until you stop its process (`pgrep -af "cli.ts serve"`,
then `kill <pid>`).

## Development

```sh
npm ci                # install dependencies from package-lock.json
npm test              # node:test suites (test/*.test.ts)
npm run typecheck     # tsc --noEmit
npm run lint          # biome check .
npm run test:e2e      # end-to-end run through bin/notebook, in a temp directory
```

Tests use temporary directories, local bare repositories, and free localhost ports. They never touch
your home directory, `~/notebook`, or global git configuration, and they make no network connections.
The end-to-end script sets its own `HOME`, git configuration, notebook directory, and port, drives
everything through `bin/notebook`, removes its website process, and deletes its temporary directory.
It needs `git`, `flock`, and `pgrep`.
