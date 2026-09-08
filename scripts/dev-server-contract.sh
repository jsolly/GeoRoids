#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/scripts/dev-server.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/georoids-dev-contract.XXXXXX")"
LISTENER_PID=""
OWNED_PID=""
OWNED_REAPER_PID=""
OWNED_PID_FILE="$TMP_DIR/owned.pid"
OWNED_CHILD_PID_FILE="$TMP_DIR/owned-child.pid"
VITE_PORT=""
SERVER_PORT=""
STATE_DIR=""

cleanup() {
  local owned_child_pid=""
  if [[ -n "$LISTENER_PID" ]] && kill -0 "$LISTENER_PID" 2>/dev/null; then
    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
  fi
  if [[ -s "$OWNED_CHILD_PID_FILE" ]]; then
    IFS= read -r owned_child_pid <"$OWNED_CHILD_PID_FILE" || true
    if [[ -n "$owned_child_pid" ]] && kill -0 "$owned_child_pid" 2>/dev/null; then
      kill -9 "$owned_child_pid" 2>/dev/null || true
    fi
  fi
  if [[ -n "$OWNED_PID" ]] && kill -0 "$OWNED_PID" 2>/dev/null; then
    kill -9 "$OWNED_PID" 2>/dev/null || true
  fi
  if [[ -n "$OWNED_REAPER_PID" ]]; then
    wait "$OWNED_REAPER_PID" 2>/dev/null || true
  fi
  if [[ -n "$STATE_DIR" ]]; then
    rm -f "$STATE_DIR/pid" "$STATE_DIR/start" "$STATE_DIR/root" 2>/dev/null || true
    rmdir "$STATE_DIR" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

if ! command -v lsof >/dev/null 2>&1; then
  echo "dev-server contract requires lsof" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "dev-server contract requires node" >&2
  exit 1
fi

find_free_port() {
  local port
  for port in $(seq 52000 52999); do
    if [[ "$port" == "${1:-}" ]]; then
      continue
    fi
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "$port"
      return 0
    fi
  done
  echo "could not find a free contract-test port" >&2
  return 1
}

assert_process_stopped() {
  local pid="$1"
  local label="$2"
  local attempt
  local state
  for ((attempt = 0; attempt < 10; attempt++)); do
    state="$(ps -p "$pid" -o stat= 2>/dev/null | sed 's/^ *//' || true)"
    case "$state" in
      ''|Z*) return 0 ;;
    esac
    sleep 0.05
  done
  echo "$label process $pid survived owned-tree cleanup" >&2
  exit 1
}

VITE_PORT="$(find_free_port)"
SERVER_PORT="$(find_free_port "$VITE_PORT")"
STATE_DIR="${TMPDIR:-/tmp}/georoids-dev-$(printf '%s' "$ROOT:$VITE_PORT:$SERVER_PORT" | shasum -a 256 | cut -c1-16)"

node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$VITE_PORT" \
  >"$TMP_DIR/listener.log" 2>&1 &
LISTENER_PID=$!

for _ in $(seq 1 20); do
  if lsof -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
if ! lsof -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "contract listener did not start" >&2
  exit 1
fi

if GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" start >"$TMP_DIR/occupied.log" 2>&1; then
  echo "dev-server unexpectedly succeeded on an occupied port" >&2
  exit 1
fi
if ! grep -qi "already in use" "$TMP_DIR/occupied.log"; then
  echo "occupied-port failure did not explain the refusal" >&2
  cat "$TMP_DIR/occupied.log" >&2
  exit 1
fi
if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
  echo "occupied-port check killed an unrelated listener" >&2
  exit 1
fi

mkdir "$STATE_DIR"
printf '%s\n' "$LISTENER_PID" >"$STATE_DIR/pid"
ps -p "$LISTENER_PID" -o lstart= | sed 's/^ *//' >"$STATE_DIR/start"
printf '%s\n' "$ROOT" >"$STATE_DIR/root"

if GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/untrusted.log" 2>&1; then
  echo "dev-server unexpectedly stopped an untrusted process" >&2
  exit 1
fi
if ! grep -qi "untrusted development PID" "$TMP_DIR/untrusted.log"; then
  echo "untrusted-PID refusal did not explain the safety failure" >&2
  cat "$TMP_DIR/untrusted.log" >&2
  exit 1
fi
if ! kill -0 "$LISTENER_PID" 2>/dev/null; then
  echo "untrusted-PID check killed an unrelated listener" >&2
  exit 1
fi

kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""
rm -f "$STATE_DIR/pid" "$STATE_DIR/start" "$STATE_DIR/root"
rmdir "$STATE_DIR"

cat >"$TMP_DIR/concurrently-contract-process" <<'EOF'
#!/usr/bin/env bash
trap '' TERM
while :; do
  sleep 30 &
  printf '%s\n' "$!" >"$GEOROIDS_CONTRACT_CHILD_PID_FILE"
  wait "$!" || true
done
EOF
chmod +x "$TMP_DIR/concurrently-contract-process"

(
  cd "$ROOT"
  GEOROIDS_CONTRACT_CHILD_PID_FILE="$OWNED_CHILD_PID_FILE" \
    "$TMP_DIR/concurrently-contract-process" &
  printf '%s\n' "$!" >"$OWNED_PID_FILE"
  wait "$!" 2>/dev/null || true
) 2>/dev/null &
OWNED_REAPER_PID=$!

for _ in $(seq 1 20); do
  [[ -s "$OWNED_PID_FILE" ]] && [[ -s "$OWNED_CHILD_PID_FILE" ]] && break
  sleep 0.05
done
if [[ ! -s "$OWNED_PID_FILE" ]] || [[ ! -s "$OWNED_CHILD_PID_FILE" ]]; then
  echo "owned process tree did not start" >&2
  exit 1
fi
OWNED_PID="$(<"$OWNED_PID_FILE")"

mkdir "$STATE_DIR"
printf '%s\n' "$OWNED_PID" >"$STATE_DIR/pid"
ps -p "$OWNED_PID" -o lstart= | sed 's/^ *//' >"$STATE_DIR/start"
printf '%s\n' "$ROOT" >"$STATE_DIR/root"

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/owned-stop.log" 2>&1; then
  echo "dev-server failed to stop its owned process tree" >&2
  cat "$TMP_DIR/owned-stop.log" >&2
  exit 1
fi

owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "owned root"
assert_process_stopped "$owned_child_pid" "owned child"
[[ ! -e "$STATE_DIR" ]] || {
  echo "owned process-tree cleanup left session metadata behind" >&2
  exit 1
}
OWNED_PID=""

echo "dev-server contract passed: occupied ports and untrusted PIDs are refused; owned trees are stopped"
