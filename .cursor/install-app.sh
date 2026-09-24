#!/usr/bin/env bash
# Install the GeoRoids application development environment on a Cloud Agent VM:
# native libraries for the `canvas` dependency, Node 24 (package.json engines
# require ^24.15.0; .nvmrc pins major 24), project dependencies, the Playwright
# browsers used by the browser integration suite, and the empty .env the game
# server loads via --env-file=.env.
#
# Idempotent: safe to re-run from .cursor/environment.json `install`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "install-app: ERROR — need root or sudo to run: $*" >&2
    return 1
  fi
}

# --- native libraries for the `canvas` dependency ---
# canvas builds against Cairo, Pango, libjpeg, giflib and librsvg headers.
if ! pkg-config --exists cairo 2>/dev/null; then
  echo "install-app: installing canvas native libraries via apt"
  run_privileged apt-get update -qq
  run_privileged apt-get install -y --no-install-recommends \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    libpixman-1-dev build-essential pkg-config python3
else
  echo "install-app: canvas native libraries already present"
fi

# --- Node 24 via nvm ---
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "install-app: ERROR — nvm not found at $NVM_DIR/nvm.sh" >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
nvm use 24
node24_dir="$(dirname "$(nvm which 24)")"
export PATH="$node24_dir:$PATH"
echo "install-app: using node $(node --version) (npm $(npm --version))"

# --- project dependencies ---
npm ci

# --- Playwright browsers for tests/integration/browser ---
npx --no-install playwright install --with-deps chromium webkit

# --- empty .env required by the server's --env-file=.env ---
[ -f .env ] || touch .env

echo "install-app: done"
