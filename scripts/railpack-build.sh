#!/usr/bin/env bash
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; open a fresh shell and rerun repository setup." >&2; exit 1; }
# Build a checkout the way Railway builds the production server, so a change that
# breaks Railpack fails CI instead of the deploy (#929's mise.lock broke its
# `mise install`). Railpack plans the checkout and chooses the files each step
# copies; BuildKit then runs every step of that plan through the same release's
# frontend: `mise install`, `npm install` and `npm run build`. The image is not
# exported.
#
# RAILPACK_VERSION must equal build.railpackVersion in .railway/railway.ts, and
# START_COMMAND its deploy.startCommand; scripts/railpack-build.test.ts fails
# otherwise. The release archive is checked against its pinned SHA-256, and the
# frontend and BuildKit images are pinned by digest. Railpack's plan names its own
# builder and runtime images by tag, exactly as on Railway. Not reproduced:
# Railway's BuildKit daemon, its service variables and build secrets. No Railway
# credential is read.
#
# Usage: bash scripts/railpack-build.sh [checkout]   (Linux x86_64, Docker Buildx)
set -euo pipefail

RAILPACK_VERSION=0.43.0
RAILPACK_SHA256=248a8f60f36854aabed6124113631078a802de3461660855fc4de9c26065c1fb
RAILPACK_FRONTEND=ghcr.io/railwayapp/railpack-frontend:v0.43.0@sha256:355ef61fae6f2551103cd8b10c710cb07167dd353d561f15c69b8d7ac1c676cc
BUILDKIT_IMAGE=moby/buildkit:v0.34.1@sha256:99368f3e46177c6405b9740e4461d91cee004128daeecca78d4ceac50ec1da5c
START_COMMAND='node --import tsx server.ts'

fail() {
  echo "✗ $1" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error title=Railway server build::$1"
  fi
  exit 1
}

# Railway's builder runs the x86_64 release; another platform would test a different binary.
if [[ "$(uname -s):$(uname -m)" != Linux:x86_64 ]]; then
  fail "Railpack builds run on Linux x86_64, as Railway does; this host is $(uname -s) $(uname -m)"
fi
app=$(cd "${1:-.}" && pwd)
work=$(mktemp -d)
builder="railpack-build-$$"
cleanup() {
  docker buildx rm --force "$builder" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

archive="railpack-v$RAILPACK_VERSION-x86_64-unknown-linux-musl.tar.gz"
url="https://github.com/railwayapp/railpack/releases/download/v$RAILPACK_VERSION/$archive"
curl --fail --location --silent --show-error --connect-timeout 10 --max-time 120 \
  "$url" --output "$work/railpack.tar.gz" ||
  fail "could not download Railpack $RAILPACK_VERSION from $url"
sha256sum --check --status <<<"$RAILPACK_SHA256  $work/railpack.tar.gz" ||
  fail "$url does not match its pinned SHA-256; verify the upstream release before changing the pin"
tar -xzf "$work/railpack.tar.gz" -C "$work" railpack
version=$("$work/railpack" --version)
[[ "$version" == "railpack version $RAILPACK_VERSION" ]] ||
  fail "the pinned archive reports '$version', not Railpack $RAILPACK_VERSION"

"$work/railpack" prepare "$app" \
  --plan-out "$work/railpack-plan.json" \
  --info-out "$work/railpack-info.json" \
  --start-cmd "$START_COMMAND" ||
  fail "Railpack $RAILPACK_VERSION could not plan this checkout (see its output above)"

docker buildx create --name "$builder" --driver docker-container \
  --driver-opt "image=$BUILDKIT_IMAGE" --bootstrap >/dev/null ||
  fail "could not start BuildKit from $BUILDKIT_IMAGE"
docker buildx build --builder "$builder" \
  --build-arg "BUILDKIT_SYNTAX=$RAILPACK_FRONTEND" \
  --file "$work/railpack-plan.json" \
  --output type=cacheonly \
  --progress plain \
  "$app" ||
  fail "Railpack $RAILPACK_VERSION could not build this checkout. When the first failing step above is a Railpack build step, Railway's production server deploy fails the same way; a tool-version change (.mise.toml, mise.lock, .nvmrc) usually fails 'install mise packages' (mise install)."
echo "✓ Railpack $RAILPACK_VERSION built this checkout through every Railway build step"
