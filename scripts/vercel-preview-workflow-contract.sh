#!/usr/bin/env bash
# Lock SHA injection on .github/workflows/vercel-preview.yml. CLI --archive=tgz
# deploys omit .git, so Vite and middleware must receive the PR head SHA.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="$ROOT/.github/workflows/vercel-preview.yml"
VERCEL_JSON="$ROOT/vercel.json"

fail() {
	echo "✗ $*" >&2
	exit 1
}

[[ -f "$WORKFLOW" ]] || fail "missing $WORKFLOW"
[[ -f "$VERCEL_JSON" ]] || fail "missing $VERCEL_JSON"

require() {
	local file="$1"
	local needle="$2"
	local label="$3"
	if ! grep -F -- "$needle" "$file" >/dev/null; then
		fail "Vercel Preview must ${label}: ${needle}"
	fi
}

require_workflow() {
	require "$WORKFLOW" "$1" "$2"
}

require_workflow 'printf '\''%s'\'' "$COMMENT_BODY" | scripts/vercel-preview-comment.sh' \
	'pipe COMMENT_BODY into the first-line /preview matcher'
require_workflow '[[ ! -x scripts/vercel-preview-comment.sh ]]' \
	'require the matcher to be executable'
require_workflow 'if [[ "$matcher_status" -eq 1 ]]; then' \
	'treat matcher exit 1 as skip and other non-zero as failure'
require_workflow '--build-env "VERCEL_GIT_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as a Vite build env'
require_workflow '--build-env "GEOROIDS_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as a CLI build fallback'
require_workflow '--env "GEOROIDS_COMMIT_SHA=${HEAD_SHA}"' 'pass the PR SHA as middleware runtime env'
require_workflow '--meta "githubDeployment=1"' 'mark the CLI deploy as a GitHub deployment'
require_workflow '--meta "githubCommitSha=${HEAD_SHA}"' 'attach the PR SHA as GitHub commit metadata'
require_workflow '--target=preview' 'force the CLI deploy onto the Preview target'
require_workflow '^[A-Za-z0-9._/-]+$' 'allowlist PR head refs before interpolating them'
require_workflow '$RUNNER_TEMP/vercel-cli' 'install the Vercel CLI outside the PR checkout'
require_workflow "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)" \
	'run only from the default branch'
require_workflow "github.event.comment.user.type == 'User'" \
	'ignore bot comments'
require_workflow "github.event.comment.author_association == 'OWNER'" \
	'allow owner /preview comments'
require_workflow "github.event.comment.author_association == 'MEMBER'" \
	'allow member /preview comments'
require_workflow "github.event.comment.author_association == 'COLLABORATOR'" \
	'allow collaborator /preview comments'
require_workflow 'echo "skip=true"' 'skip non-matching /preview comments'
require_workflow 'error<<PREVIEW_ERROR_EOF' 'record resolve and deploy errors for the PR comment'
require_workflow "always() && steps.pr.outputs.skip != 'true' && steps.pr.outputs.pr_number != ''" \
	'comment on resolve and deploy failures'
require_workflow 'RESOLVE_ERROR: ${{ steps.pr.outputs.error }}' \
	'surface resolve errors on the pull request'
require_workflow '"$state" != "open"' 'refuse closed pull requests'
require_workflow 'not deploying forks' 'refuse fork heads'
require_workflow "steps.pr.outputs.skip != 'true' && steps.pr.outputs.head_sha != ''" \
	'skip checkout and deploy unless the PR head SHA is resolved'
require "$VERCEL_JSON" '"main": true' 'keep Git deploys on main'
require "$VERCEL_JSON" '"*": false' 'disable Git deploys on single-segment branches'
require "$VERCEL_JSON" '"**": false' 'disable Git deploys on unmatched branches'

echo "✓ vercel-preview workflow injects the PR commit SHA"
