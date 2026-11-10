#!/usr/bin/env bash
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; open a fresh shell and rerun repository setup." >&2; exit 1; }
set -euo pipefail
# Cursor beforeShellExecution gate. Stdout is only the permission JSON.
input="$(cat)"
command="$(printf '%s' "$input" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("command", ""), end="")')" || {
  printf '%s\n' '{"permission":"deny","user_message":"The gitleaks gate could not read the shell command."}'
  exit 0
}

root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$root" ]]; then
  printf '%s\n' '{"permission":"deny","user_message":"The gitleaks gate could not find the git checkout."}'
  exit 0
fi
cd "$root"

deny() {
  SECURITY_GATE_REASON="$1" SECURITY_GATE_DETAIL="$2" python3 -c 'import json,os; print(json.dumps({"permission":"deny","user_message":os.environ["SECURITY_GATE_REASON"],"agent_message":os.environ.get("SECURITY_GATE_DETAIL","")[:4000]}))'
  exit 0
}

run_scan() {
  local reason="$1"
  shift
  local out="" rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [[ "$rc" != 0 ]]; then
    deny "$reason" "$out"
  fi
}

if [[ "$command" == *"git commit"* ]]; then
  # The single-quoted program is the command bash -c runs; it is not expanded here.
  # shellcheck disable=SC2016
  run_scan "gitleaks refused this commit." bash -c 'set -euo pipefail; source "$1/gate/gate-lib.sh" && gate_secrets_scan_staged' bash "$root"
fi
if [[ "$command" == *"git push"* ]]; then
  run_scan "gitleaks refused this push." bash "$root/scripts/security-scan.sh" cursor-push
fi
printf '%s\n' '{"permission":"allow"}'
