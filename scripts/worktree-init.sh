#!/usr/bin/env bash
# Copy the gitignored files listed in .worktreeinclude from the primary checkout into
# the current worktree. Run `npm run worktree:init` after a manual `git worktree add`;
# Cursor runs that command through .cursor/worktrees.json.
#
# Copy, never symlink — a symlinked .env.local resolves outside the worktree root and
# trips Vite's server.fs.allow. cp -p preserves the 0600 mode on .env.local.
#
# Non-fatal by design: a missing primary, missing manifest, or zero glob matches must
# not block the `npm ci` that follows in worktree:init. Always exits 0.
set -uo pipefail

dest="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
manifest="$dest/.worktreeinclude"
[ -f "$manifest" ] || exit 0

# The first `worktree` entry in --porcelain output is the primary checkout. Strip the
# fixed `worktree ` prefix rather than field-splitting — the path is verbatim and may
# contain spaces, which `awk '{print $2}'` would truncate.
if ! primary="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n1)"; then
  echo "worktree-init: could not inspect Git worktrees; skipping optional provisioning" >&2
  exit 0
fi
[ -n "$primary" ] || exit 0
[ "$primary" = "$dest" ] && exit 0  # running in the primary itself; nothing to copy

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"                                  # strip trailing comment
  line="${line#"${line%%[![:space:]]*}"}"             # trim leading whitespace
  line="${line%"${line##*[![:space:]]}"}"             # trim trailing whitespace
  [ -n "$line" ] || continue
  # Reject absolute paths and `..` traversal.
  # .worktreeinclude is repo-controlled, but `../../.ssh/id_rsa` would read outside the
  # primary AND, since the prefix-strip leaves `..` in $rel, write outside the worktree.
  case "/$line/" in
    //*|*/../*) echo "worktree-init: skipping unsafe .worktreeinclude entry '$line'" >&2; continue ;;
  esac
  for src in "$primary"/$line; do                     # glob-expand against the primary
    [ -e "$src" ] || continue                         # tolerate zero matches
    rel="${src#"$primary"/}"
    if ! mkdir -p "$dest/$(dirname "$rel")"; then
      echo "worktree-init: could not create destination for '$rel'; continuing without optional copy" >&2
      continue
    fi
    if cp -p "$src" "$dest/$rel"; then
      echo "worktree-init: copied $rel" >&2
    else
      echo "worktree-init: failed to copy '$rel'; continuing without optional copy" >&2
    fi
  done
done < "$manifest"

exit 0
