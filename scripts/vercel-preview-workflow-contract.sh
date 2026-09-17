#!/usr/bin/env bash
# Lock SHA injection on .github/workflows/vercel-preview.yml. CLI --archive=tgz
# deploys omit .git, so Vite and middleware must receive the PR head SHA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/vercel-preview.yml"

fail() {
	echo "✗ $*" >&2
	exit 1
}

[[ -f "$WORKFLOW" ]] || fail "missing $WORKFLOW"

require() {
	local needle="$1"
	local label="$2"
	if ! grep -F -- "$needle" "$WORKFLOW" >/dev/null; then
		fail "Vercel Preview workflow must ${label}: ${needle}"
	fi
}

require 'printf '\''%s'\'' "$COMMENT_BODY" | scripts/vercel-preview-comment.sh' \
	'pipe COMMENT_BODY into the first-line /preview matcher'
require '[[ ! -x scripts/vercel-preview-comment.sh ]]' \
	'require the matcher to be executable'
require 'if [[ "$matcher_status" -eq 1 ]]; then' \
	'treat matcher exit 1 as skip and other non-zero as failure'
require '--build-env "VERCEL_GIT_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as a Vite build env'
require '--build-env "GEOROIDS_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as a CLI build fallback'
require '--env "GEOROIDS_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as middleware runtime env'
require '--meta "githubDeployment=1"' 'mark the CLI deploy as a GitHub deployment'
require '--meta "githubCommitSha=${HEAD_SHA}"' 'attach the PR SHA as GitHub commit metadata'
require '--target=preview' 'force the CLI deploy onto the Preview target'
require '^[A-Za-z0-9._/-]+$' 'allowlist PR head refs before interpolating them'
require '$RUNNER_TEMP/vercel-cli' 'install the Vercel CLI outside the PR checkout'

echo "✓ vercel-preview workflow injects the PR commit SHA"
