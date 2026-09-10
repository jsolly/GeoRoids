#!/usr/bin/env bash
# Lint markdown with the markdownlint-cli2 version pinned in package.json / package-lock.json.
# Pass --fix to auto-fix violations: bash scripts/lint-md.sh --fix
#
# Require the locally installed binary from `npm ci`: the quality gate must use the lockfile-
# grounded tool and must fail closed when dependencies are missing.
set -euo pipefail
cd "$(dirname "$0")/.."
bin="node_modules/.bin/markdownlint-cli2"
if [[ ! -x "$bin" ]]; then
  echo "✗ markdownlint-cli2 not found at $bin — run 'npm ci'" >&2
  exit 1
fi
exec "$bin" "$@" "**/*.md" "**/AGENTS.ms"
