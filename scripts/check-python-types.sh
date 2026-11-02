#!/usr/bin/env bash
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; open a fresh shell and rerun repository setup." >&2; exit 1; }
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
uvx --from mypy==2.4.1 --with Pillow==12.3.0 mypy --config-file config/python/mypy.ini
