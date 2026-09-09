#!/usr/bin/env bash
# Lint markdown with the locally installed markdownlint-cli2 declared in package.json.
# Pass --fix to auto-fix violations: bash scripts/lint-md.sh --fix
set -euo pipefail
cd "$(dirname "$0")/.."
bin="node_modules/.bin/markdownlint-cli2"
if [[ -x "$bin" ]]; then
  exec "$bin" "$@" "**/*.md" "**/AGENTS.ms"
fi
echo "lint-md: $bin not found — run 'npm ci' in the repository, then retry." >&2
exit 1
