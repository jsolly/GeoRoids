#!/usr/bin/env bash
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; open a fresh shell and rerun repository setup." >&2; exit 1; }
set -euo pipefail
session_hook=false
case "$#:$*" in
  0:) ;;
  1:--session-hook) session_hook=true ;;
  *) echo "Usage: $0 [--session-hook]" >&2; exit 2 ;;
esac
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
[[ -f package-lock.json ]] || { echo 'package-lock.json is required for repository setup.' >&2; exit 1; }
[[ ! -L node_modules ]] || { echo 'node_modules must belong to this checkout; symlinked dependencies are refused.' >&2; exit 1; }
# A fresh Linux cloud image may not have the public tool manager. Install only
# this pinned, checksum-verified upstream binary; never pipe a remote script to a shell.
install_public_mise() (
  existing="$(command -v mise 2>/dev/null || true)"
  if [[ -n "$existing" && -x "$existing" ]]; then
    "$existing" --version >/dev/null
    exit 0
  fi
  local_version=2026.9.12
  destination='/usr/local/bin/mise'
  case "$(uname -s) $(uname -m)" in
    'Linux x86_64') asset="mise-v${local_version}-linux-x64"; expected=e79ae57945034903aee8aa2ea66b4c7ca9cd4f4edd5a8a78a589cbae6d0f428a ;;
    'Linux aarch64' | 'Linux arm64') asset="mise-v${local_version}-linux-arm64"; expected=f344c6961190ed2f68e595ed7cb4f03c36c17812bd608886bec799a3082180ff ;;
    *) echo 'Install mise on this host, then rerun repository setup. See docs/development.md.' >&2; exit 1 ;;
  esac
  [[ ! -e "$destination" && ! -L "$destination" ]] || { echo 'A mise destination already exists outside PATH; inspect it before setup.' >&2; exit 1; }
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  curl --fail --silent --show-error --location --retry 3 \
    "https://github.com/jdx/mise/releases/download/v${local_version}/${asset}" -o "$scratch/mise"
  bash "$root/scripts/repo-python.sh" -c \
    'import hashlib, pathlib, sys; actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest(); sys.exit(0 if actual == sys.argv[2] else "Downloaded mise checksum does not match the repository pin")' \
    "$scratch/mise" "$expected"
  chmod 0755 "$scratch/mise"
  "$scratch/mise" --version >/dev/null
  if [[ -w "$(dirname "$destination")" ]]; then
    install -m 0755 "$scratch/mise" "$destination"
  else
    sudo -n install -m 0755 "$scratch/mise" "$destination"
  fi
  command -v mise >/dev/null || { echo 'mise was installed in /usr/local/bin; put that directory on PATH before retrying setup.' >&2; exit 1; }
)

# Setup writes env.sh here; later shells source it to put the pinned Node and uv first on PATH.
env_file="$HOME/.local/share/georoids-toolchain/env.sh"

# Claude Code sources $CLAUDE_ENV_FILE before each later Bash command of the session, so the
# session hook adds env.sh there once and every command runs on the pinned Node.
register_session_env() {
  local line
  [[ -n "${CLAUDE_ENV_FILE:-}" && -f "$env_file" ]] || return 0
  line=". \"$env_file\""
  grep -qxF "$line" "$CLAUDE_ENV_FILE" 2>/dev/null || printf '%s\n' "$line" >>"$CLAUDE_ENV_FILE"
}

# Install a pinned single-binary scanner from its GitHub release download URL into the gate's
# GATE_TOOLCHAIN_BIN, where its lookups find it. mise resolves these through the GitHub API, which
# Claude's cloud sessions cannot reach, while release downloads work there. The extracted binary
# must match the gate library's hash for this platform before it is installed or run.
# scripts/security-scan.sh keeps its own Linux installers for CI: they pin archive hashes that
# CI's contract test shares with ci.yml, where this one checks the binary on every platform.
install_pinned_release() ( # <gitleaks|zizmor|osv-scanner>
  tool="$1"
  case "$tool" in
    gitleaks) base="https://github.com/gitleaks/gitleaks/releases/download/v$GATE_GITLEAKS_VERSION" ;;
    zizmor) base="https://github.com/zizmorcore/zizmor/releases/download/v$GATE_ZIZMOR_VERSION" ;;
    osv-scanner) base="https://github.com/google/osv-scanner/releases/download/v$GATE_OSV_SCANNER_VERSION" ;;
    *) echo "✗ No pinned release for $tool." >&2; exit 1 ;;
  esac
  # Archive member, or empty for a release that is the bare binary.
  member="$tool"
  case "$tool $(uname -s) $(uname -m)" in
    'gitleaks Linux x86_64') asset="gitleaks_${GATE_GITLEAKS_VERSION}_linux_x64.tar.gz" ;;
    'gitleaks Linux aarch64' | 'gitleaks Linux arm64') asset="gitleaks_${GATE_GITLEAKS_VERSION}_linux_arm64.tar.gz" ;;
    'gitleaks Darwin arm64') asset="gitleaks_${GATE_GITLEAKS_VERSION}_darwin_arm64.tar.gz" ;;
    'zizmor Linux x86_64') asset=zizmor-x86_64-unknown-linux-gnu.tar.gz ;;
    'zizmor Linux aarch64' | 'zizmor Linux arm64') asset=zizmor-aarch64-unknown-linux-gnu.tar.gz ;;
    'zizmor Darwin arm64') asset=zizmor-aarch64-apple-darwin.tar.gz ;;
    'osv-scanner Linux x86_64') asset=osv-scanner_linux_amd64; member='' ;;
    'osv-scanner Linux aarch64' | 'osv-scanner Linux arm64') asset=osv-scanner_linux_arm64; member='' ;;
    'osv-scanner Darwin arm64') asset=osv-scanner_darwin_arm64; member='' ;;
    *) echo "✗ No pinned $tool release for $(uname -s) $(uname -m). Install the gate's pinned $tool on PATH, then rerun $0." >&2; exit 1 ;;
  esac
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  url="$base/$asset"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 20 --max-time 300 "$url" -o "$scratch/download"
  if [[ -n "$member" ]]; then
    tar -xzf "$scratch/download" -C "$scratch" "$member" ||
      { echo "✗ $url holds no $member binary. Nothing was installed." >&2; exit 1; }
    bin="$scratch/$member"
  else
    bin="$scratch/download"
  fi
  "gate__verify_${tool//-/_}_bin" "$bin" || { echo "✗ Nothing was installed from $url." >&2; exit 1; }
  mkdir -p "$GATE_TOOLCHAIN_BIN"
  install -m 0755 "$bin" "$GATE_TOOLCHAIN_BIN/$tool"
)

# The gate's tools, each from the source that works without the GitHub API where it can.
# Node always comes from mise, whose installation the dependency receipt records. uv is mise's
# when mise has it, else the host's, and mise installs it only when PATH has none. Semgrep is a
# Python distribution mise installs from PyPI, asked from / with the gate's pin so .mise.toml's
# uv entry is not an install dependency. gitleaks, zizmor and osv-scanner come from their release
# archives when the gate's own lookup finds no pinned copy. env.sh records only mise's Node and
# uv directories, which are the same whatever PATH this run started with.
install_toolchain() {
  local tool node_path uv_path="" staged joined
  mise install node
  node_path="$(MISE_EXEC_AUTO_INSTALL=false mise which node)"
  joined="$(dirname "$node_path")"
  if ! uv_path="$(MISE_EXEC_AUTO_INSTALL=false mise which uv 2>/dev/null)"; then
    uv_path=""
    if ! command -v uv >/dev/null 2>&1 || ! command -v uvx >/dev/null 2>&1; then
      mise install uv
      uv_path="$(MISE_EXEC_AUTO_INSTALL=false mise which uv)"
    fi
  fi
  [[ -z "$uv_path" ]] || joined="$joined:$(dirname "$uv_path")"
  export PATH="$joined:$PATH"
  gate_semgrep_bin >/dev/null 2>&1 || (cd / && mise install "semgrep@$GATE_SEMGREP_VERSION")
  for tool in gitleaks zizmor osv-scanner; do
    "gate_${tool//-/_}_bin" >/dev/null 2>&1 || install_pinned_release "$tool"
  done
  # Written beside env.sh and renamed over it, so a failure leaves an earlier env.sh whole.
  mkdir -p "$(dirname "$env_file")"
  staged="$(mktemp "$env_file.XXXXXX")"
  # shellcheck disable=SC2016 # $PATH is expanded by the shell that sources env.sh
  { printf 'export PATH="%s:$PATH"\n' "$joined" >"$staged" && mv -f "$staged" "$env_file"; } ||
    { rm -f "$staged"; echo "✗ Could not write $env_file; the error is above." >&2; return 1; }
  # shellcheck source=/dev/null # written just above
  source "$env_file"
  for tool in gitleaks zizmor osv-scanner semgrep; do
    "gate_${tool//-/_}_bin" >/dev/null || { echo "✗ The installed toolchain still lacks $tool; the gate's error is above." >&2; return 1; }
  done
  command -v uvx >/dev/null || { echo '✗ uvx is not on PATH after setup.' >&2; return 1; }
}

# A successful npm ci binds the dependency tree to its inputs and runtime.
# npm's hidden lock alone does not prove that the current tree still matches it.
# Verification reads the runtime identity from the installation mise resolves and
# leaves the complete npm ls tree check to the write: a new cloud session's disk is
# slow, and starting node and npm pages in thousands of blocks.
dependency_receipt() {
  MISE_EXEC_AUTO_INSTALL=false bash scripts/repo-python.sh - "$1" <<'PYTHON'
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys

receipt = Path('node_modules/.georoids-setup.json')

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def resolved(tool):
    path = Path(subprocess.check_output(['mise', 'which', tool], text=True).strip())
    if not path.is_absolute() or path.name != tool or path.parent.name != 'bin':
        raise ValueError(f'mise resolved {tool} to an unexpected path: {path}')
    return path.resolve(strict=True)

def node_runtime(prefix):
    # Same value as node -p [process.version, process.versions.modules, process.platform, process.arch].
    # Identity comes from the installation's header and this host, so a damaged node
    # binary or one built for another architecture under emulation is not detected.
    header = (prefix / 'include/node/node_version.h').read_text()
    def define(name):
        return re.search(rf'^#define {name} (\d+)$', header, re.M).group(1)
    version = 'v' + '.'.join(define(f'NODE_{part}_VERSION') for part in ('MAJOR', 'MINOR', 'PATCH'))
    system = {'Linux': 'linux', 'Darwin': 'darwin'}[platform.system()]
    arch = {'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}[platform.machine()]
    return json.dumps([version, define('NODE_MODULE_VERSION'), system, arch], separators=(',', ':'))

try:
    inputs = {name: digest(name) for name in (
        'package.json', 'package-lock.json', '.npmrc', '.mise.toml', '.nvmrc')}
    hidden_lock = Path('node_modules/.package-lock.json')
    packages = json.loads(hidden_lock.read_text())['packages']
    manifests = {}
    for name in packages:
        path = Path(name)
        if not path.parts or path.parts[0] != 'node_modules' or '..' in path.parts:
            raise ValueError('Invalid installed package path')
        manifests[name] = digest(path / 'package.json')
    prefix = resolved('node').parents[1]
    # mise's bin/npm wraps the npm bundled with this Node; its manifest carries npm --version.
    if prefix not in resolved('npm').parents:
        raise ValueError('npm does not belong to the resolved Node installation')
    npm = json.loads((prefix / 'lib/node_modules/npm/package.json').read_text())['version']
    current = {'version': 1, 'inputs': inputs, 'runtime': node_runtime(prefix), 'npm': npm,
               'installedLock': digest(hidden_lock), 'manifests': manifests}
    if sys.argv[1] == 'verify' and json.loads(receipt.read_text()) != current:
        raise ValueError('Dependency inputs, runtime or installed packages changed')
    if sys.argv[1] == 'write':
        subprocess.run(['mise', 'exec', '--', 'npm', 'ls', '--all', '--include=dev',
                        '--include=optional', '--include=peer'], check=True, stdout=subprocess.DEVNULL)
        receipt.write_text(json.dumps(current, sort_keys=True) + '\n')
except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, RuntimeError,
        subprocess.CalledProcessError) as error:
    print(f'Dependency setup verification failed: {error}', file=sys.stderr)
    sys.exit(1)
PYTHON
}

# A warm hook must not reinstall dependencies or tools beneath a running service.
# An old or incomplete tree needs a deliberate repair after its services stop.
if $session_hook && [[ -e node_modules || -L node_modules ]]; then
  # A cached cloud environment keeps hooks installed from the bundle reviewed when it
  # was built. Reinstall only that stale case; install refuses a bundle not yet trusted.
  hooks_rc=0
  hooks_out="$(bash scripts/repo-python.sh scripts/repo-hooks.py verify --root "$root" 2>&1)" || hooks_rc=$?
  if ((hooks_rc == 0)); then
    printf '%s\n' "$hooks_out"
  elif [[ "$hooks_out" == 'repo-hooks: Installed bundle is stale; run reviewed repository setup' ]]; then
    echo 'Installed hooks predate the trusted current bundle; reinstalling them' >&2
    # Cloud environments check out the session commit without updating origin/main,
    # so refresh that trust anchor before install compares the bundle against it.
    # A session hook must never wait on a credential, passphrase or host-key prompt;
    # a user's own SSH command or core.sshCommand still takes precedence.
    ssh_command="${GIT_SSH_COMMAND:-$(git config --get core.sshCommand || echo 'ssh -o BatchMode=yes -o ConnectTimeout=20')}"
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="$ssh_command" \
      git -c credential.interactive=false -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      fetch --quiet --no-tags --no-write-fetch-head --no-auto-maintenance origin \
      '+refs/heads/main:refs/remotes/origin/main' ||
      echo 'Could not refresh origin/main; install compares against the local copy' >&2
    bash scripts/repo-python.sh scripts/repo-hooks.py install --root "$root"
  else
    printf '%s\n' "$hooks_out" >&2
    exit "$hooks_rc"
  fi
  if ! dependency_receipt verify; then
    echo "Stop this checkout's services with npm run dev:kill, then run bash scripts/setup-agent-environment.sh explicitly to repair dependencies." >&2
    exit 1
  fi
  [[ -e .env ]] || touch .env
  register_session_env
  echo 'Repository environment ready; existing dependencies verified without reinstalling.'
  exit 0
fi

# Installation validates the complete reviewed bundle before writing hook state.
# It runs no dependency lifecycle script. Unreviewed setup cannot upgrade hooks.
bash scripts/repo-python.sh scripts/repo-hooks.py install --root "$root"
if [[ "$(uname -s)" == Linux ]] && ! pkg-config --exists cairo pangocairo librsvg-2.0 pixman-1 2>/dev/null; then
  if [[ "$(id -u)" == 0 ]]; then
    apt-get update -qq
    apt-get install -y --no-install-recommends libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev build-essential pkg-config python3
  else
    sudo -n apt-get update -qq
    sudo -n apt-get install -y --no-install-recommends libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libpixman-1-dev build-essential pkg-config python3
  fi
fi
install_public_mise
mise trust "$root/.mise.toml"
# shellcheck source=/dev/null
source "$root/gate/gate-lib.sh"
install_toolchain
# A failed repair must never leave an old success receipt behind.
rm -f node_modules/.georoids-setup.json
# Not auto-installing: .mise.toml lists tools this host got from their release archives.
MISE_EXEC_AUTO_INSTALL=false mise exec -- npm ci
dependency_receipt write
# The local server's --env-file requires a file; never replace existing settings.
[[ -e .env ]] || touch .env
bash scripts/repo-python.sh scripts/repo-hooks.py verify --root "$root"
register_session_env
echo 'Repository environment ready; no private configuration repository is required.'
echo "Later shells put the pinned Node first on PATH with: . \"$env_file\""
