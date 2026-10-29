#!/bin/sh
# Opt-in installer for notebook. Run it yourself; it never edits shell profiles or OpenCode
# config and never overwrites a different existing file.
set -eu

DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [--dry-run] [--help]

Installs notebook for the current user:
  ~/.local/bin/notebook                        symlink to this checkout's bin/notebook
  ~/.config/opencode/skills/notebook/SKILL.md  copy of skills/notebook/SKILL.md
  ~/notebook (or $NOTEBOOK_DIR)                created with 'notebook init' if missing

Existing files that differ are refused, not overwritten. Running it again is safe.

Options:
  --dry-run   Print every action without changing anything
  --help      Show this help
EOF
}

die() {
  printf 'install: error: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'install: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

script_dir=$(cd -P -- "$(dirname -- "$0")" && pwd -P) ||
  die "cannot locate the checkout"
repo=$(cd -P -- "$script_dir/.." && pwd -P) || die "cannot locate the checkout"

command -v git >/dev/null 2>&1 || die "git is required but was not found on PATH"
command -v flock >/dev/null 2>&1 ||
  die "flock (util-linux) is required but was not found on PATH"
command -v node >/dev/null 2>&1 ||
  die "node 24 or newer is required but was not found on PATH"
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || node_major=0
case $node_major in
  '' | *[!0-9]*) node_major=0 ;;
esac
if [ "$node_major" -lt 24 ]; then
  die "node 24 or newer is required (found $(node -v 2>/dev/null || echo unknown))"
fi

bin_dir="$HOME/.local/bin"
link="$bin_dir/notebook"
target="$repo/bin/notebook"
skill_src="$repo/skills/notebook/SKILL.md"
skill_dir="$HOME/.config/opencode/skills/notebook"
skill_dst="$skill_dir/SKILL.md"
notebook_dir=${NOTEBOOK_DIR:-$HOME/notebook}

if [ -e "$bin_dir" ] && [ ! -d "$bin_dir" ]; then
  die "$bin_dir exists but is not a directory"
fi

link_state=missing
if [ -L "$link" ]; then
  if [ "$(readlink "$link")" = "$target" ]; then
    link_state=same
  else
    link_state=other
  fi
elif [ -e "$link" ]; then
  link_state=other
fi
if [ "$link_state" = other ]; then
  die "$link already exists and does not point to $target; move it aside and run again"
fi

skill_state=missing
if [ -L "$skill_dst" ]; then
  skill_state=other
elif [ -e "$skill_dst" ]; then
  if [ -f "$skill_dst" ] && cmp -s "$skill_src" "$skill_dst"; then
    skill_state=same
  else
    skill_state=other
  fi
fi
if [ "$skill_state" = other ]; then
  die "$skill_dst already exists and differs from the bundled skill; move it aside and run again"
fi

nb_state=missing
if [ -e "$notebook_dir" ]; then
  if [ ! -d "$notebook_dir" ]; then
    die "$notebook_dir exists but is not a directory"
  fi
  nb_state=exists
fi

if [ "$DRY_RUN" = 1 ]; then
  printf 'Dry run: no changes will be made.\n'
fi

case $link_state in
  same) printf 'Launcher: already installed (%s -> %s)\n' "$link" "$target" ;;
  missing)
    if [ "$DRY_RUN" = 1 ]; then
      printf '[dry-run] would link %s -> %s (creating %s if needed)\n' \
        "$link" "$target" "$bin_dir"
    else
      mkdir -p "$bin_dir"
      ln -s "$target" "$link"
      printf 'Launcher: linked %s -> %s\n' "$link" "$target"
    fi
    ;;
esac

case $skill_state in
  same) printf 'Skill: already installed (%s)\n' "$skill_dst" ;;
  missing)
    if [ "$DRY_RUN" = 1 ]; then
      printf '[dry-run] would copy %s to %s\n' "$skill_src" "$skill_dst"
    else
      mkdir -p "$skill_dir"
      cp "$skill_src" "$skill_dst"
      printf 'Skill: installed %s\n' "$skill_dst"
    fi
    ;;
esac

case $nb_state in
  exists) printf 'Notebook: %s already exists; not changed\n' "$notebook_dir" ;;
  missing)
    if [ "$DRY_RUN" = 1 ]; then
      printf '[dry-run] would run: %s --dir %s init\n' "$target" "$notebook_dir"
    else
      "$target" --dir "$notebook_dir" init
    fi
    ;;
esac

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    printf 'Warning: %s is not on your PATH. Add it in your shell profile yourself;\n' "$bin_dir"
    printf '         this script does not edit profiles.\n'
    ;;
esac

if [ "$DRY_RUN" = 1 ]; then
  printf 'Dry run complete: nothing was changed.\n'
  exit 0
fi

cat <<EOF

Next steps:
  1. Optional backup: create a private repository, then run:
       git -C "$notebook_dir" remote add origin <private-repo-url>
       notebook backup
     Use a private repository only; entries can contain personal notes.
  2. Restart your agent session (OpenCode or T3 Code) so it discovers the notebook skill.
  3. Check the setup with: notebook status
EOF
