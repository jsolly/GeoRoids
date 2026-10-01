#!/usr/bin/env bash
# Heavy regression checks belong in the local review/fix loop and full ship gate.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .performance/review
ARTIFACTS="$(mktemp -d "$ROOT/.performance/review/run.XXXXXX")"
echo "Review artifacts: $ARTIFACTS"
stage=integration
node scripts/review-receipt.mjs start "$ARTIFACTS" "$ROOT"

retain_stage() {
  mkdir -p "$ARTIFACTS/$stage"
  if [[ "$stage" == integration ]]; then
    # The coordinator retains each isolated shard directly; its receipt names the home.
    [[ -s "$ARTIFACTS/integration/shards.json" ]] || { echo "Missing integration shard receipt" >&2; return 1; }
    return 0
  fi
  local source
  for source in logs tests/integration/browser/screenshots; do
    if [[ -d "$source" ]]; then
      if ! cp -R "$source" "$ARTIFACTS/$stage/"; then
        echo "Failed to retain $source" >&2
        return 1
      fi
    fi
  done
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
  GEOROIDS_TEST_RUNNER_RECEIPT="$ARTIFACTS/$stage/runner.json" "$@" 2>&1 | tee "$ARTIFACTS/$stage/output.log" || status=$?
  # Each runner clears live logs, so copy before starting the next stage.
  retain_stage || return 1
  if [[ "$status" != 0 ]]; then return "$status"; fi
  node scripts/review-receipt.mjs stage "$ARTIFACTS" "$stage" "$status" "$@"
}

# The runner owns integration serialization, services, deadlines, and cleanup.
# Full discovery includes every scenario formerly run by PR behavioral CI.
run_stage integration env GEOROIDS_TEST_SHARD_RECEIPT="$ARTIFACTS/integration/shards.json" ./scripts/test-runner.sh --shards=6 tests/integration/ --reporter=verbose

run_stage frame node --import tsx scripts/measure-frame-work.ts \
  --budget docs/performance/frame-work-budget.json \
  --output "$ARTIFACTS/frame-work.json"

run_stage traversal env GEOROIDS_TEST_MAX_DURATION_SECONDS=240 ./scripts/test-runner.sh --benchmark-client \
  --viewport touch-portrait --dpr 3 --cpu-slowdown 4 --network normal \
  --scenario traversal --seed 42 --warmup 5 --seconds 15 \
  --output "$ARTIFACTS/mobile-combined.json"
run_stage combat env GEOROIDS_TEST_MAX_DURATION_SECONDS=240 ./scripts/test-runner.sh --benchmark-client \
  --viewport touch-portrait --dpr 3 --cpu-slowdown 1 --network clean \
  --scenario combat --seed 42 --warmup 5 --seconds 15 \
  --output "$ARTIFACTS/mobile-combat.json"
