#!/usr/bin/env bash
# Complete code integration belongs in the local review and ship gate.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == --validation-child ]]; then
  shift
  node scripts/validation-admission.mjs verify review "$$" || exit 1
else
  exec node scripts/validation-admission.mjs review -- "$BASH" "$ROOT/scripts/test-review.sh" --validation-child "$@"
fi
mkdir -p .performance/review
ARTIFACTS="$(mktemp -d "$ROOT/.performance/review/run.XXXXXX")"
echo "Review artifacts: $ARTIFACTS"
stage=integration
node scripts/review-receipt.mjs start "$ARTIFACTS" "$ROOT"

retain_stage() {
  [[ -s "$ARTIFACTS/integration/runner.json" ]] || { echo "Missing code integration receipt" >&2; return 1; }
}

finish() {
  local status=$?
  trap - EXIT
  local retention=true
  if ! retain_stage; then
    retention=false
    if [[ "$status" == 0 ]]; then status=1; fi
  fi
  printf 'exit_status=%s\n' "$status" > "$ARTIFACTS/result.txt" || status=1
  if ! node scripts/review-receipt.mjs finish "$ARTIFACTS" "$status" "$retention" "${GEOROIDS_REVIEW_RECEIPT:-$ARTIFACTS/review.json}"; then status=1; fi
  echo "Review exit $status; artifacts: $ARTIFACTS"
  exit "$status"
}
trap finish EXIT

run_stage() {
  stage=$1
  shift
  mkdir -p "$ARTIFACTS/$stage"
  local status=0
  "$@" 2>&1 | tee "$ARTIFACTS/$stage/output.log" || status=$?
  # Validate retained code integration evidence before recording the stage.
  retain_stage || return 1
  if [[ "$status" != 0 ]]; then return "$status"; fi
  node scripts/review-receipt.mjs stage "$ARTIFACTS" "$stage" "$status" "$@"
}

# The runner owns serial code integration, its deadline and process cleanup.
run_stage integration env GEOROIDS_CODE_INTEGRATION_RECEIPT="$ARTIFACTS/integration/runner.json" ./scripts/test-runner.sh --reporter=verbose
