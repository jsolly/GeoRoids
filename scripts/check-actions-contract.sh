#!/usr/bin/env bash

# Exercise scripts/check-actions.sh download, cache, checksum, and handoff
# boundaries without contacting GitHub or running the real actionlint binary.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/georoids-check-actions-contract.XXXXXX")"
FIXTURE="$TEMP_DIR/repository"
MOCK_BIN="$TEMP_DIR/mock-bin"
CURL_COUNT_FILE="$TEMP_DIR/curl-count"
ARGS_FILE="$TEMP_DIR/actionlint-args"
SHELLCHECK_BYTES='fixture-shellcheck-archive'
ACTIONLINT_BYTES='fixture-actionlint-archive'

cleanup() {
	rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

fail() {
	echo "✗ $*" >&2
	exit 1
}

mkdir -p \
	"$FIXTURE/scripts" \
	"$FIXTURE/.github/workflows" \
	"$FIXTURE/node_modules" \
	"$MOCK_BIN"

SHELLCHECK_DIGEST="$(printf '%s' "$SHELLCHECK_BYTES" | shasum -a 256 | awk '{print $1}')"
ACTIONLINT_DIGEST="$(printf '%s' "$ACTIONLINT_BYTES" | shasum -a 256 | awk '{print $1}')"
sed \
	-e "s/339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f/$SHELLCHECK_DIGEST/" \
	-e "s/aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f/$ACTIONLINT_DIGEST/" \
	"$ROOT/scripts/check-actions.sh" > "$FIXTURE/scripts/check-actions.sh"
chmod +x "$FIXTURE/scripts/check-actions.sh"
cat > "$FIXTURE/.github/workflows/check.yml" <<'EOF'
name: contract
on: workflow_dispatch
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo contract
EOF

cat > "$MOCK_BIN/uname" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf '%s\n' Darwin ;;
  -m) printf '%s\n' arm64 ;;
  *) exit 64 ;;
esac
EOF

cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

output=''
url=''
while (($# > 0)); do
  case "$1" in
    --output)
      output="$2"
      shift 2
      ;;
    *)
      url="$1"
      shift
      ;;
  esac
done
[ -n "$output" ] || exit 64
[ -n "$url" ] || exit 64

count=0
if [ -f "$CONTRACT_CURL_COUNT_FILE" ]; then
  IFS= read -r count < "$CONTRACT_CURL_COUNT_FILE" || true
fi
printf '%s\n' "$((count + 1))" > "$CONTRACT_CURL_COUNT_FILE"

if [[ "$CONTRACT_MODE" == failed-download && "$url" == *"$CONTRACT_TARGET"* ]]; then
  exit 23
fi
if [[ "$CONTRACT_MODE" == truncated && "$url" == *"$CONTRACT_TARGET"* ]]; then
  printf '%s' truncated-archive > "$output"
elif [[ "$url" == *actionlint* ]]; then
  printf '%s' "$CONTRACT_ACTIONLINT_BYTES" > "$output"
else
  printf '%s' "$CONTRACT_SHELLCHECK_BYTES" > "$output"
fi
EOF

cat > "$MOCK_BIN/tar" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

archive=''
destination=''
while (($# > 0)); do
  case "$1" in
    -xzf)
      archive="$2"
      shift 2
      ;;
    -C)
      destination="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -f "$archive" ] || exit 64
[ -n "$destination" ] || exit 64

payload="$(cat "$archive")"
case "$payload" in
  "$CONTRACT_SHELLCHECK_BYTES")
    mkdir -p "$destination/shellcheck-v0.11.0"
    cat > "$destination/shellcheck-v0.11.0/shellcheck" <<'SCRIPT'
#!/usr/bin/env bash
exit 0
SCRIPT
    chmod +x "$destination/shellcheck-v0.11.0/shellcheck"
    ;;
  "$CONTRACT_ACTIONLINT_BYTES")
cat > "$destination/actionlint" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CONTRACT_ACTIONLINT_ARGS_FILE"
if [[ "${CONTRACT_MODE:-}" == actionlint-failure ]]; then
	exit 17
fi
exit 0
SCRIPT
    chmod +x "$destination/actionlint"
    ;;
  *)
    echo "unexpected fixture archive" >&2
    exit 65
    ;;
esac
EOF
chmod +x "$MOCK_BIN/uname" "$MOCK_BIN/curl" "$MOCK_BIN/tar"

run_checker() {
	local mode="$1"
	local output_file="$TEMP_DIR/$mode.log"
	if CONTRACT_MODE="$mode" \
		CONTRACT_TARGET="${target:-actionlint}" \
		CONTRACT_CURL_COUNT_FILE="$CURL_COUNT_FILE" \
		CONTRACT_ACTIONLINT_ARGS_FILE="$ARGS_FILE" \
		CONTRACT_SHELLCHECK_BYTES="$SHELLCHECK_BYTES" \
		CONTRACT_ACTIONLINT_BYTES="$ACTIONLINT_BYTES" \
		PATH="$MOCK_BIN:$PATH" \
		bash "$FIXTURE/scripts/check-actions.sh" > "$output_file" 2>&1; then
		return 0
	else
		local status=$?
		return "$status"
	fi
}

assert_no_workdirs() {
	local leftover
	leftover="$(find "$FIXTURE/node_modules/.cache" -type d -name 'check-actions.*' -print -quit)"
	[ -z "$leftover" ] || fail "checker left temporary workdir: $leftover"
}

SHELLCHECK_ARCHIVE="$FIXTURE/node_modules/.cache/shellcheck/v0.11.0/darwin.aarch64/release.tar.gz"
ACTIONLINT_ARCHIVE="$FIXTURE/node_modules/.cache/actionlint/v1.7.12/darwin_arm64/release.tar.gz"

rm -f "$CURL_COUNT_FILE" "$ARGS_FILE"
run_checker success || fail "initial checker run failed"
assert_no_workdirs
[ "$(cat "$CURL_COUNT_FILE")" = 2 ] || fail "initial run did not download both archives"
[ -f "$SHELLCHECK_ARCHIVE" ] || fail "ShellCheck archive was not promoted"
[ -f "$ACTIONLINT_ARCHIVE" ] || fail "actionlint archive was not promoted"
grep -Fxq -- '-shellcheck' "$ARGS_FILE" || fail "actionlint did not receive ShellCheck"
grep -Fxq -- '-ignore' "$ARGS_FILE" || fail "actionlint did not receive the ignore option"
grep -Fqx -- 'input "client-id" is not defined in action "actions/create-github-app-token@' "$ARGS_FILE" || \
	fail "actionlint ignore value changed"
grep -Fxq -- '.github/workflows/check.yml' "$ARGS_FILE" || fail "actionlint did not receive the workflow path"

rm -f "$ARGS_FILE"
run_checker cached || fail "cached checker run failed"
assert_no_workdirs
[ "$(cat "$CURL_COUNT_FILE")" = 2 ] || fail "cached run downloaded an archive"
[ -s "$ARGS_FILE" ] || fail "cached run skipped actionlint"

rm -f "$ARGS_FILE"
if run_checker actionlint-failure; then
	fail "actionlint failure was swallowed"
else
	status=$?
fi
[ "$status" -eq 17 ] || fail "actionlint failure returned unexpected status $status"
assert_no_workdirs

for target in actionlint shellcheck; do
  if [[ "$target" == actionlint ]]; then
    archive="$ACTIONLINT_ARCHIVE"
    label=Actionlint
  else
    archive="$SHELLCHECK_ARCHIVE"
    label=ShellCheck
  fi
  downloads_before="$(cat "$CURL_COUNT_FILE")"
  printf '%s' tampered-archive > "$archive"
  rm -f "$ARGS_FILE"
  if run_checker cache-tampered; then
    fail "tampered $target cache was accepted"
  else
    status=$?
  fi
  [ "$status" -eq 1 ] || fail "$target tampered cache returned unexpected status $status"
  assert_no_workdirs
  grep -Fq "$label archive checksum mismatch" "$TEMP_DIR/cache-tampered.log" || \
    fail "$target tampered cache failure was not reported"
  [ ! -s "$ARGS_FILE" ] || fail "$target tampered cache reached actionlint"
  [ "$(cat "$CURL_COUNT_FILE")" = "$downloads_before" ] || fail "$target tampered cache triggered a download"

  rm -f "$archive" "$ARGS_FILE"
  if run_checker failed-download; then
    fail "failed $target download was accepted"
  else
    status=$?
  fi
  [ "$status" -eq 23 ] || fail "$target failed download returned unexpected status $status"
  assert_no_workdirs
  [ ! -e "$archive" ] || fail "$target failed download was promoted to cache"
  [ ! -s "$ARGS_FILE" ] || fail "$target failed download reached actionlint"

  if run_checker truncated; then
    fail "truncated $target archive was accepted"
  else
    status=$?
  fi
  [ "$status" -eq 1 ] || fail "$target truncated archive returned unexpected status $status"
  assert_no_workdirs
  grep -Fq "$label archive checksum mismatch" "$TEMP_DIR/truncated.log" || \
    fail "$target truncated archive failure was not reported"
  [ ! -e "$archive" ] || fail "$target truncated archive was promoted to cache"
  [ ! -s "$ARGS_FILE" ] || fail "$target truncated archive reached actionlint"
done

echo "✓ check-actions contract passed"
