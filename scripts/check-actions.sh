#!/usr/bin/env bash
# Lint GitHub Actions workflows with actionlint + shellcheck.
#
# Actionlint and ShellCheck use official release archives pinned by version and
# SHA-256 below; verify each archive before extraction/execution. The verified
# archives are cached inside node_modules for local/CI parity.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_MODULES="$ROOT/node_modules"
if [[ ! -d "$NODE_MODULES" ]]; then
	echo "✗ node_modules not found at $NODE_MODULES — run npm ci" >&2
	exit 1
fi

ACTIONLINT_VERSION=v1.7.12
SHELLCHECK_VERSION=v0.11.0
DOWNLOAD_CONNECT_TIMEOUT_SECONDS=10
DOWNLOAD_MAX_TIME_SECONDS=120

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    platform=darwin.aarch64
    digest=339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f
    actionlint_platform=darwin_arm64
    actionlint_digest=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
    ;;
  Darwin:x86_64)
    platform=darwin.x86_64
    digest=c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51
    actionlint_platform=darwin_amd64
    actionlint_digest=5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644
    ;;
  Linux:aarch64|Linux:arm64)
    platform=linux.aarch64
    digest=68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc
    actionlint_platform=linux_arm64
    actionlint_digest=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6
    ;;
  Linux:x86_64)
    platform=linux.x86_64
    digest=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6
    actionlint_platform=linux_amd64
    actionlint_digest=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    ;;
  *) echo "Unsupported actionlint/ShellCheck platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac
shellcheck_cache="$NODE_MODULES/.cache/shellcheck/$SHELLCHECK_VERSION/$platform"
shellcheck_archive="$shellcheck_cache/release.tar.gz"
actionlint_cache="$NODE_MODULES/.cache/actionlint/$ACTIONLINT_VERSION/$actionlint_platform"
actionlint_archive="$actionlint_cache/release.tar.gz"
mkdir -p "$shellcheck_cache" "$actionlint_cache" "$NODE_MODULES/.cache"
work_root="$(mktemp -d "$NODE_MODULES/.cache/check-actions.XXXXXX")"
shellcheck_work="$work_root/shellcheck"
actionlint_work="$work_root/actionlint"
mkdir -p "$shellcheck_work" "$actionlint_work"
trap 'rm -rf "$work_root"' EXIT

shellcheck_source="$shellcheck_archive"
if [[ ! -f "$shellcheck_archive" ]]; then
  curl --fail --location --silent --show-error \
    --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$DOWNLOAD_MAX_TIME_SECONDS" \
    "https://github.com/koalaman/shellcheck/releases/download/$SHELLCHECK_VERSION/shellcheck-$SHELLCHECK_VERSION.$platform.tar.gz" \
    --output "$shellcheck_work/download.tar.gz"
  shellcheck_source="$shellcheck_work/download.tar.gz"
fi
actual="$(shasum -a 256 "$shellcheck_source")"
if [[ "${actual%% *}" != "$digest" ]]; then
  echo "ShellCheck archive checksum mismatch: $shellcheck_source (remove it and retry)" >&2
  exit 1
fi
tar -xzf "$shellcheck_source" -C "$shellcheck_work"
SHELLCHECK="$shellcheck_work/shellcheck-$SHELLCHECK_VERSION/shellcheck"
if [[ ! -x "$SHELLCHECK" ]]; then
	echo "✗ ShellCheck binary missing after extraction: $SHELLCHECK" >&2
	exit 1
fi
if [[ "$shellcheck_source" == "$shellcheck_work/download.tar.gz" ]]; then
  mv "$shellcheck_source" "$shellcheck_archive"
  shellcheck_source="$shellcheck_archive"
fi

actionlint_archive_name="actionlint_${ACTIONLINT_VERSION#v}_${actionlint_platform}.tar.gz"
actionlint_source="$actionlint_archive"
if [[ ! -f "$actionlint_archive" ]]; then
  curl --fail --location --silent --show-error \
    --connect-timeout "$DOWNLOAD_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$DOWNLOAD_MAX_TIME_SECONDS" \
    "https://github.com/rhysd/actionlint/releases/download/$ACTIONLINT_VERSION/$actionlint_archive_name" \
    --output "$actionlint_work/download.tar.gz"
  actionlint_source="$actionlint_work/download.tar.gz"
fi
actual="$(shasum -a 256 "$actionlint_source")"
if [[ "${actual%% *}" != "$actionlint_digest" ]]; then
	echo "Actionlint archive checksum mismatch: $actionlint_source (remove it and retry)" >&2
	exit 1
fi
tar -xzf "$actionlint_source" -C "$actionlint_work"
ACTIONLINT="$actionlint_work/actionlint"
if [[ ! -x "$ACTIONLINT" ]]; then
	echo "✗ Actionlint binary missing after extraction: $ACTIONLINT" >&2
	exit 1
fi
if [[ "$actionlint_source" == "$actionlint_work/download.tar.gz" ]]; then
  mv "$actionlint_source" "$actionlint_archive"
fi

# actionlint v1.7.12 bundles pre-v3.1 create-github-app-token metadata (no
# client-id; app-id still required). Workflows retain app-id alongside client-id.
# Drop this -ignore flag when actionlint's popular-actions registry catches up
# (rhysd/actionlint#652 / #668).
"$ACTIONLINT" -shellcheck "$SHELLCHECK" \
	-ignore 'input "client-id" is not defined in action "actions/create-github-app-token@' \
	.github/workflows/*.yml
