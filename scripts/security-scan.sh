#!/usr/bin/env bash
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; open a fresh shell and rerun repository setup." >&2; exit 1; }
set -euo pipefail
# Local and CI entry for the scanners that are not already the staged gitleaks check.
# Pre-commit calls `zizmor`. Pre-push calls `pre-push`. CI calls history, semgrep, osv, and zizmor.

root="$(git rev-parse --show-toplevel)"
cd "$root"
# shellcheck source=/dev/null
source "$root/gate/gate-lib.sh"

security_tool_dir="${HOME}/.local/bin"

security_download() { # <url> <sha256> <dest>
  local url="$1" sha="$2" dest="$3"
  curl --fail --location --silent --show-error "$url" --output "$dest"
  echo "$sha  $dest" | sha256sum --check
}

security_linux_asset() { # <x64-name> <x64-sha> <arm64-name> <arm64-sha>
  case "$(uname -m)" in
    x86_64) printf '%s %s\n' "$1" "$2" ;;
    aarch64 | arm64) printf '%s %s\n' "$3" "$4" ;;
    *)
      echo "✗ security scan has no pinned archive for $(uname -m)" >&2
      return 1
      ;;
  esac
}

install_gitleaks() {
  local asset sha tmp
  read -r asset sha < <(security_linux_asset \
    gitleaks_8.24.2_linux_x64.tar.gz fa0500f6b7e41d28791ebc680f5dd9899cd42b58629218a5f041efa899151a8e \
    gitleaks_8.24.2_linux_arm64.tar.gz 574a6d52573c61173add7ddb5e3cc68c0e82cb0735818a1eeb9a0a2de1643fbc)
  tmp="$(mktemp -d)"
  security_download \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GATE_GITLEAKS_VERSION}/${asset}" \
    "$sha" "$tmp/archive.tar.gz"
  tar -xzf "$tmp/archive.tar.gz" -C "$tmp" gitleaks
  mkdir -p "$security_tool_dir"
  install -m 755 "$tmp/gitleaks" "$security_tool_dir/gitleaks"
  rm -rf "$tmp"
  export PATH="${security_tool_dir}:${PATH}"
  hash -r
}

install_zizmor() {
  local asset sha tmp
  read -r asset sha < <(security_linux_asset \
    zizmor-x86_64-unknown-linux-gnu.tar.gz bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b \
    zizmor-aarch64-unknown-linux-gnu.tar.gz cb152b207f815116d7fa1c1ee4614f61578803351395052908095e79adfd9fd0)
  tmp="$(mktemp -d)"
  security_download \
    "https://github.com/zizmorcore/zizmor/releases/download/v${GATE_ZIZMOR_VERSION}/${asset}" \
    "$sha" "$tmp/archive.tar.gz"
  tar -xzf "$tmp/archive.tar.gz" -C "$tmp" zizmor
  mkdir -p "$security_tool_dir"
  install -m 755 "$tmp/zizmor" "$security_tool_dir/zizmor"
  rm -rf "$tmp"
  export PATH="${security_tool_dir}:${PATH}"
  hash -r
}

install_osv() {
  local asset sha tmp
  read -r asset sha < <(security_linux_asset \
    osv-scanner_linux_amd64 fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8 \
    osv-scanner_linux_arm64 983d22fbad9724514e3fcc6acc83b5fa64c5ffa6b0d9f510028f22c1b223ff81)
  tmp="$(mktemp -d)"
  security_download \
    "https://github.com/google/osv-scanner/releases/download/v${GATE_OSV_SCANNER_VERSION}/${asset}" \
    "$sha" "$tmp/osv-scanner"
  mkdir -p "$security_tool_dir"
  install -m 755 "$tmp/osv-scanner" "$security_tool_dir/osv-scanner"
  rm -rf "$tmp"
  export PATH="${security_tool_dir}:${PATH}"
  hash -r
}

install_semgrep() {
  python3 -m pip install --user --disable-pip-version-check "semgrep==${GATE_SEMGREP_VERSION}" \
    || python3 -m pip install --user --break-system-packages --disable-pip-version-check "semgrep==${GATE_SEMGREP_VERSION}"
  export PATH="${security_tool_dir}:${PATH}"
  hash -r
}

ensure_tool() { # <probe-fn> <install-fn>
  if "$1" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "${GITHUB_ACTIONS:-}" == true ]]; then
    "$2"
  fi
  "$1" >/dev/null
}

run_zizmor() {
  local bin
  ensure_tool gate_zizmor_bin install_zizmor
  bin="$(gate_zizmor_bin)"
  echo "• zizmor (offline)"
  "$bin" --offline --config "$root/config/security/zizmor.yml" "$root"
}

# mise resolves a lock-installed Semgrep only beside mise.lock, so name this checkout.
semgrep_bin() { gate_semgrep_bin "$root"; }

run_semgrep() {
  local bin base
  ensure_tool semgrep_bin install_semgrep
  bin="$(semgrep_bin)"
  base="${SECURITY_BASE_SHA:-}"
  if [[ -z "$base" ]]; then
    if ! git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
      echo "✗ semgrep needs refs/remotes/origin/main or SECURITY_BASE_SHA" >&2
      return 1
    fi
    base="$(git merge-base HEAD refs/remotes/origin/main)"
  fi
  git cat-file -e "${base}^{commit}"
  echo "• semgrep (p/default, baseline ${base})"
  "$bin" scan --config p/default --error --metrics=off --disable-version-check --baseline-commit "$base" "$root"
}

run_osv() {
  local bin
  ensure_tool gate_osv_scanner_bin install_osv
  bin="$(gate_osv_scanner_bin)"
  echo "• osv-scanner (package-lock.json)"
  "$bin" scan source --lockfile "$root/package-lock.json" --config "$root/config/security/osv-scanner.toml"
}

run_cursor_push() {
  local count
  ensure_tool gate_gitleaks_bin install_gitleaks
  if ! git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
    echo "✗ gitleaks push scan needs refs/remotes/origin/main" >&2
    return 1
  fi
  count="$(git rev-list --count refs/remotes/origin/main..HEAD)"
  if [[ "$count" == 0 ]]; then
    echo "• gitleaks (origin/main..HEAD empty)"
    return 0
  fi
  echo "• gitleaks (origin/main..HEAD)"
  gate_secrets_scan_log "refs/remotes/origin/main..HEAD"
}

run_pre_push() {
  local local_ref local_sha remote_sha range count
  ensure_tool gate_gitleaks_bin install_gitleaks
  ensure_tool semgrep_bin install_semgrep
  ensure_tool gate_osv_scanner_bin install_osv
  while read -r local_ref local_sha _remote_ref remote_sha; do
    [[ -n "$local_ref" ]] || continue
    if [[ "$local_sha" =~ ^0+$ ]]; then
      continue
    fi
    if [[ ! "$local_sha" =~ ^[0-9a-fA-F]{40,64}$ || ! "$remote_sha" =~ ^[0-9a-fA-F]{40,64}$ ]]; then
      echo "✗ pre-push received a revision that is not a commit id" >&2
      return 1
    fi
    if [[ "$remote_sha" =~ ^0+$ ]]; then
      if ! git rev-parse --verify --quiet refs/remotes/origin/main >/dev/null; then
        echo "✗ a new branch needs refs/remotes/origin/main for the gitleaks range" >&2
        return 1
      fi
      range="refs/remotes/origin/main..${local_sha}"
    else
      range="${remote_sha}..${local_sha}"
    fi
    count="$(git rev-list --count "$range")"
    if [[ "$count" == 0 ]]; then
      continue
    fi
    echo "• gitleaks (${range})"
    gate_secrets_scan_log "$range"
  done
  run_semgrep
  run_osv
}

case "${1:-}" in
  zizmor) run_zizmor ;;
  history)
    ensure_tool gate_gitleaks_bin install_gitleaks
    echo "• gitleaks (full history)"
    gate_secrets_scan_log
    ;;
  semgrep) run_semgrep ;;
  osv) run_osv ;;
  cursor-push) run_cursor_push ;;
  pre-push) run_pre_push ;;
  *)
    echo "Usage: $0 {zizmor|history|semgrep|osv|cursor-push|pre-push}" >&2
    exit 2
    ;;
esac
