# Notebook

A private, local-first library of interactive HTML explanations and reusable
prompts. Create and deepen pages in Claude/Codex, then revisit them through a local
website. Plain files and Git keep the content and its history on your machine.
Nothing is captured automatically.

## Requirements

- Node.js 24 or newer; TypeScript runs directly with no build step.
- Git and `flock` (util-linux).
- `xdg-open` to launch a browser automatically; otherwise open the printed URL.

## Install

From this checkout:

```sh
scripts/install.sh --dry-run
scripts/install.sh
```

The installer links `~/.local/bin/notebook` to this checkout, copies the complete
notebook skill into `~/.claude/skills/notebook/` and `~/.codex/skills/notebook/`, and
initializes `~/notebook` (or `$NOTEBOOK_DIR`) if missing. Existing notebooks are
preserved. It checks prerequisites and refuses differing existing files.

To refresh an installed skill, move its installed folder aside and rerun the
installer. Restart your Claude/Codex session to discover updated instructions.
Add `~/.local/bin` to your PATH if necessary; the installer never edits profiles
or agent configuration.

## Everyday use

```sh
notebook open
```

The website has **Pages** and **Prompts**, both listed newest first with their
project and a filter that narrows the list as you type; click a project to show
only its items. Pages open directly in an interactive viewer. Prompts are
ready-to-copy blocks with a copy button in the corner; templated prompts expand
inline to fill their inputs. The website browses content and fills/copies
prompts; creation and changes happen through Claude/Codex or the CLI.

Example requests:

- "Explain Git rebasing visually and save it to my notebook."
- "Add our conflict-resolution example to my Git rebasing page. Keep the animation."
- "Save this as a reusable prompt called Explore a concept visually."
- "Use my Explore a concept visually prompt to explain worktrees."
- "Show the history of my rebasing page and restore the previous version."

Copy-and-paste prompt for saving findings:

```text
Use the notebook skill to save the key findings from this session as an interactive HTML page in my notebook.
```

A **concept** is a living explanation; a **report** records dated findings. Each
page has a stable URL, one current HTML document, metadata, and optional supporting
context for future updates. Context is CLI-readable and excluded from browser
search and HTML export. Saves publish after validation; restore creates a new
revision in Git.

## CLI

Every command supports `--dir PATH`, `--port N`, and `--json`. The directory
defaults to `$NOTEBOOK_DIR`, then `~/notebook`; the port defaults to `$NOTEBOOK_PORT`,
then `43127`. `notebook --help` lists commands and flags.

```sh
notebook init
notebook status --json
notebook open --no-browser
notebook serve
notebook backup --json
```

### Pages

Create input contains `title`, `summary`, `kind` (`concept` or `report`), optional
`project` (default Inbox), `topics`, `sources`, `context`, and prompt provenance.
IDs, timestamps, and revisions are managed by the tool.

```json
{"title":"Git rebasing","summary":"Replay commits on a new base.","kind":"concept","topics":["git"],"sources":[]}
```

```sh
notebook page create --input /tmp/page.json --html /tmp/page.html --json
notebook page search "rebasing" --topic git --json
notebook page read <id> --json
notebook page update <id> --expected-revision <hash> --input /tmp/patch.json --html /tmp/page.html --json
notebook page open <id>
```

Updates require `change_summary` and preserve omitted fields. `context: null`
clears context; metadata-only updates can omit `--html`. Every mutation checks the
latest revision and refuses stale updates. HTML must be a regular file,
at most 20 MiB. Titles are at most 200 characters, summaries 500, project names 80,
and topics at most 20 normalized slugs. Text fields are bounded; serialized YAML
metadata is at most 64 KiB. Unknown and managed input fields are rejected.

### Prompts

Templates use exact `{{name}}` placeholders. Named inputs have descriptions and
optional literal defaults; inputs without defaults are required.

```json
{"title":"Explain visually","description":"Create an interactive explanation.","template":"Explain {{concept}} for {{audience}} visually.","inputs":[{"name":"concept","description":"What to explain"},{"name":"audience","description":"Who it is for","default":"a curious developer"}]}
```

```sh
notebook prompt create --input /tmp/prompt.json --json
notebook prompt search "visually" --json
notebook prompt read <id> --json
notebook prompt render <id> --values /tmp/values.json --json
notebook prompt update <id> --expected-revision <hash> --input /tmp/patch.json --json
notebook prompt open <id>
```

Example values: `{"concept":"Git worktrees"}`. Rendering substitutes values
literally once. Missing/unknown inputs fail validation; templates do not execute
code, read files, or expand environment variables. Rendering never saves content
or authorizes execution. Prompt updates require `change_summary`.

Browser inputs and previews stay in memory, clear on navigation/reload, and are
not sent to the server or written to storage. Copy is user initiated, with a
selectable-text fallback. Updating a prompt does not regenerate pages. A page may
pin the prompt's ID and exact revision as optional provenance.

### History

Use either `page` or `prompt`:

```sh
notebook page history <id> --json
notebook page version <id> --commit <full-commit-id> --json
notebook page restore <id> --commit <full-commit-id> --expected-revision <current> --json
```

History is also browsable on the website. Stable URLs are `/pages/<id>` and
`/prompts/<id>`, including after updates, renames, and restoration. Restore makes
a new commit without resetting the repository. The application never deletes
content or rewrites Git history. Records saved by older versions may contain an
`archived` field; it is ignored and dropped on the next save.

## Storage and consistency

```text
<notebook>/
  .notebook-format         # notebook-format 2
  .gitignore              # excludes .notebook/
  pages/<id>/page.yaml     # page metadata
  pages/<id>/index.html    # primary artifact
  pages/<id>/context.md    # optional supporting context
  prompts/<id>.md          # YAML metadata and template text
  .notebook/               # private locks, recovery journal, backup state and logs
```

The application supports format 2. Initialization refuses a non-empty directory
that is not already a supported notebook. It does not adopt or convert other
repositories. Extra files already stored in the notebook are preserved and have
no browsing or editing interface. Existing page provenance remains readable.

New-item reads use a single committed Git snapshot. Uncommitted manual edits are
not published and block mutations targeting them. Each successful mutation is
one commit containing only its own files, under a shared write lock. Page
revisions cover metadata, HTML, and context presence/content.

Interrupted writes recover before the next mutation. If recovery encounters
unexpected manual Git/index/target changes, it stops instead of overwriting them.
Do not delete `.notebook/transactions/` as cache cleanup. Normal committed content
remains readable while publication is in progress. Recovery tests cover process
interruptions, not every possible hardware failure.

## Privacy and report isolation

Pages are self-contained HTML: inline CSS/scripts and embedded images/fonts.
External scripts, styles, fonts, frames, and data requests are blocked. Reports
run inside an iframe with `sandbox="allow-scripts"`, without same-origin access.
The content response also applies a sandbox, including when opened directly.
Scripts cannot read the notebook shell, prompt inputs, cookies, or browser storage.
Current and historical reports use the same protections.

The trusted shell owns navigation, history, and downloads. Prompt preview uses a
small local script with a separate CSP. The server binds to `127.0.0.1`, validates
Host, accepts only GET/HEAD, and sends no-store, nosniff, and no-referrer headers.
Localhost is not authentication: other programs/users on the machine can reach
the site while it runs. `serve` stops with Ctrl+C; a server launched by `open`
continues running until stopped.

The viewer is intended for your own reports. A frame can navigate itself, and a
script can consume CPU/memory. Downloaded HTML opened from disk does not inherit
the server's response-header protections. Open reports through the viewer.

Metadata, context, templates, and HTML are scanned for common secret patterns
before writing. Unpublished history is scanned again before backup, including
files outside the current content directories. The scanner reports rule/location,
never matched values. It is a safeguard, not proof that content contains no secret.
There is no bypass flag. Nothing is captured automatically; no telemetry or
external report dependency is added.

## Optional private backup

Create an empty private repository, then:

```sh
git -C ~/notebook remote add origin <private-repository-url>
notebook backup --json
```

Use the appropriate directory if you configured `$NOTEBOOK_DIR`. Git credentials
must already work non-interactively. The tool never changes global Git config.
After saves it tries a protected push with a 10-second timeout, never force-pushes,
and never automatically pulls, merges, or rebases.

- `pushed`: committed content reached the remote.
- `pending (no_remote)`: content is saved locally; no remote is configured.
- `pending (push_failed)` or `(timeout)`: local save succeeded; retry backup later.
- `blocked (secret_in_unpublished_commit)`: nothing is pushed; remove the secret
  from unpublished history manually before retrying.

A secret removed in a later commit is still present in earlier history and blocks
backup. If a secret was already pushed, revoke it. Resolve divergent remotes and
unfinished Git operations manually; the tool will not overwrite remote work.

## Development

See [AGENTS.md](AGENTS.md).

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run test:e2e
```

Tests automatically use isolated HOME/Git configuration, temporary notebooks,
local bare remotes, and free localhost ports. They never use the real notebook.
There is no build step. Browser checks use synthetic data and an isolated profile.

## Uninstall

Remove the installed launcher (only if it points to this checkout) and the
installed `notebook` skill folders under `~/.claude/skills/` and `~/.codex/skills/`.
Stop any running notebook server before removing the checkout. Content stays in
your notebook directory until you explicitly remove it yourself.
