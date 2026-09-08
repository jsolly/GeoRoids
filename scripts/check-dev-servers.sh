#!/usr/bin/env bash
# Report the GeoRoids development session owned by this checkout.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/scripts/dev-server.sh" --status
