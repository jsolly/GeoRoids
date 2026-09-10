#!/usr/bin/env bash
# Lint GitHub Actions workflows with actionlint + shellcheck.
#
# Both linters come from their official release archives. Versions and SHA-256
# digests are pinned below; verify each archive before extraction/execution.
# The verified archives are cached inside node_modules for local/CI parity.
#
# Copy into each workflow repo as scripts/check-actions.sh, then:
#   "check:actions": "bash scripts/check-actions.sh"
# in package.json, plus `run_step "actionlint" npm run check:actions` in
# .git-hooks/pre-commit and `- run: npm run check:actions` in ci.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ACTIONLINT_VERSION=v1.7.12
SHELLCHECK_VERSION=v0.11.0
DOWNLOAD_CONNECT_TIMEOUT_SECONDS=10
DOWNLOAD_MAX_TIME_SECONDS=120

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) actionlint_platform=darwin_arm64; actionlint_digest=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f ;;
  Darwin:x86_64) actionlint_platform=darwin_amd64; actionlint_digest=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644 ;;
  Linux:aarch64|Linux:arm64) actionlint_platform=linux_arm64; actionlint_digest=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6 ;;
  Linux:x86_64) actionlint_platform=linux_amd64; actionlint_digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 ;;
  *) echo "Unsupported actionlint platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
actionlint_cache="$ROOT/node_modules/.cache/actionlint/$ACTIONLINT_VERSION/$actionlint_platform"
mkdir -p "$actionlint_cache"
actionlint_archive="$actionlint_cache/release.tar.gz"
actionlint_work="$(mktemp -d "$actionlint_cache/run.XXXXXX")"
cleanup_dirs=("$actionlint_work")
cleanup() { rm -rf "${cleanup_dirs[@]}"; }
trap cleanup EXIT
if [[ ! -f "$actionlint_archive" ]]; then
  curl --fail --location --silent --show-error \
    --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$DOWNLOAD_MAX_TIME_SECONDS" \
    "https://github.com/rhysd/actionlint/releases/download/$ACTIONLINT_VERSION/actionlint_${ACTIONLINT_VERSION#v}_$actionlint_platform.tar.gz" \
    --output "$actionlint_work/download.tar.gz"
  actionlint_archive="$actionlint_work/download.tar.gz"
fi
actionlint_actual="$(shasum -a 256 "$actionlint_archive")"
if [[ "${actionlint_actual%% *}" != "$actionlint_digest" ]]; then
  echo "actionlint archive checksum mismatch: $actionlint_archive (remove it and retry)" >&2
  exit 1
fi
if [[ "$actionlint_archive" == "$actionlint_work/download.tar.gz" ]]; then
  mv "$actionlint_archive" "$actionlint_cache/release.tar.gz"
  actionlint_archive="$actionlint_cache/release.tar.gz"
fi
tar -xzf "$actionlint_archive" -C "$actionlint_work"
ACTIONLINT="$actionlint_work/actionlint"
if [[ ! -x "$ACTIONLINT" ]]; then
  echo "✗ actionlint archive did not contain an executable actionlint binary" >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64) platform=darwin.aarch64; digest=339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f ;;
  Darwin:x86_64) platform=darwin.x86_64; digest=c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51 ;;
  Linux:aarch64|Linux:arm64) platform=linux.aarch64; digest=68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc ;;
  Linux:x86_64) platform=linux.x86_64; digest=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 ;;
  *) echo "Unsupported ShellCheck platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
cache="$ROOT/node_modules/.cache/shellcheck/$SHELLCHECK_VERSION/$platform"
mkdir -p "$cache"
archive="$cache/release.tar.gz"
work="$(mktemp -d "$cache/run.XXXXXX")"
cleanup_dirs+=("$work")
if [[ ! -f "$archive" ]]; then
  curl --fail --location --silent --show-error \
    --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$DOWNLOAD_MAX_TIME_SECONDS" \
    "https://github.com/koalaman/shellcheck/releases/download/$SHELLCHECK_VERSION/shellcheck-$SHELLCHECK_VERSION.$platform.tar.gz" \
    --output "$work/download.tar.gz"
  archive="$work/download.tar.gz"
fi
actual="$(shasum -a 256 "$archive")"
if [[ "${actual%% *}" != "$digest" ]]; then
  echo "ShellCheck archive checksum mismatch: $archive (remove it and retry)" >&2
  exit 1
fi
if [[ "$archive" == "$work/download.tar.gz" ]]; then
  mv "$archive" "$cache/release.tar.gz"
  archive="$cache/release.tar.gz"
fi
tar -xzf "$archive" -C "$work"
SHELLCHECK="$work/shellcheck-$SHELLCHECK_VERSION/shellcheck"

# actionlint 1.7.x bundles pre-v3.1 create-github-app-token metadata (no
# client-id; app-id still required). Workflows retain app-id alongside client-id.
# Drop this -ignore flag when actionlint's popular-actions registry catches up
# (rhysd/actionlint#652 / #668).
"$ACTIONLINT" -shellcheck "$SHELLCHECK" \
	-ignore 'input "client-id" is not defined in action "actions/create-github-app-token@' \
	.github/workflows/*.yml

shopt -s nullglob
shell_sources=(.git-hooks/* scripts/*.sh)
if [[ "${#shell_sources[@]}" -eq 0 ]]; then
  echo "✗ No repository shell scripts found for ShellCheck" >&2
  exit 1
fi
"$SHELLCHECK" --shell=bash "${shell_sources[@]}"
