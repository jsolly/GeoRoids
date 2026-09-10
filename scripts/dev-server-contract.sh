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
MOCK_BIN="$TMP_DIR/mock-bin"
PGREP_MOCK_BIN="$TMP_DIR/pgrep-mock-bin"
LSOF_MOCK_BIN="$TMP_DIR/lsof-mock-bin"
PS_MOCK_BIN="$TMP_DIR/ps-mock-bin"
VITE_PORT=""
SERVER_PORT=""
STATE_DIR=""
REAL_RMDIR="$(command -v rmdir)"
REAL_LSOF="$(command -v lsof)"
REAL_PS="$(command -v ps)"

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

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" status >"$TMP_DIR/free-status.log" 2>&1; then
  echo "dev-server reported failure while both contract ports were free" >&2
  cat "$TMP_DIR/free-status.log" >&2
  exit 1
fi
if ! grep -q "No GeoRoids development session is running" "$TMP_DIR/free-status.log"; then
  echo "free-port status did not report the expected idle session" >&2
  cat "$TMP_DIR/free-status.log" >&2
  exit 1
fi

mkdir -p "$LSOF_MOCK_BIN"
cat >"$LSOF_MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
if [[ "${GEOROIDS_CONTRACT_MODE:-}" == process-cwd-status-one ]] && [[ " $* " == *" -d cwd "* ]]; then
  echo "simulated lsof cwd inspection failure (status 1)" >&2
  exit 1
fi
if [[ "${GEOROIDS_CONTRACT_MODE:-}" == port-inspection-status-one ]]; then
  echo "simulated lsof inspection failure (status 1)" >&2
  exit 1
fi
echo "simulated lsof inspection failure (status 2)" >&2
exit 2
EOF
chmod +x "$LSOF_MOCK_BIN/lsof"

node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$VITE_PORT" \
  >"$TMP_DIR/lsof-failure-listener.log" 2>&1 &
LISTENER_PID=$!
for _ in $(seq 1 20); do
  if "$REAL_LSOF" -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
if ! "$REAL_LSOF" -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "lsof-failure contract listener did not start" >&2
  exit 1
fi

if PATH="$LSOF_MOCK_BIN:$PATH" GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" start >"$TMP_DIR/lsof-failure-start.log" 2>&1; then
  echo "dev-server unexpectedly started after lsof port inspection failed" >&2
  exit 1
fi
if ! grep -q "Could not inspect TCP port" "$TMP_DIR/lsof-failure-start.log"; then
  echo "lsof port failure did not explain the startup refusal" >&2
  cat "$TMP_DIR/lsof-failure-start.log" >&2
  exit 1
fi
if ! grep -q "simulated lsof inspection failure (status 2)" "$TMP_DIR/lsof-failure-start.log"; then
  echo "lsof status-2 failure did not preserve its actionable cause" >&2
  cat "$TMP_DIR/lsof-failure-start.log" >&2
  exit 1
fi
[[ ! -e "$STATE_DIR" ]] || {
  echo "lsof port failure left development session metadata behind" >&2
  exit 1
}
kill -0 "$LISTENER_PID" 2>/dev/null || {
  echo "lsof port failure killed an unowned listener" >&2
  exit 1
}

if PATH="$LSOF_MOCK_BIN:$PATH" GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" status >"$TMP_DIR/lsof-failure-status.log" 2>&1; then
  echo "dev-server status unexpectedly reported success after lsof inspection failed" >&2
  exit 1
fi
if ! grep -q "Could not inspect TCP port" "$TMP_DIR/lsof-failure-status.log"; then
  echo "lsof port failure did not explain the status refusal" >&2
  cat "$TMP_DIR/lsof-failure-status.log" >&2
  exit 1
fi
if ! grep -q "simulated lsof inspection failure (status 2)" "$TMP_DIR/lsof-failure-status.log"; then
  echo "lsof status-2 status failure did not preserve its actionable cause" >&2
  cat "$TMP_DIR/lsof-failure-status.log" >&2
  exit 1
fi
kill -0 "$LISTENER_PID" 2>/dev/null || {
  echo "lsof status failure killed an unowned listener" >&2
  exit 1
}

if PATH="$LSOF_MOCK_BIN:$PATH" GEOROIDS_CONTRACT_MODE=port-inspection-status-one \
  GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" start >"$TMP_DIR/lsof-status-one-start.log" 2>&1; then
  echo "dev-server unexpectedly started after lsof exit-1 inspection error" >&2
  exit 1
fi
if ! grep -q "Could not inspect TCP port" "$TMP_DIR/lsof-status-one-start.log" || \
  ! grep -q "exit 1" "$TMP_DIR/lsof-status-one-start.log" || \
  ! grep -q "simulated lsof inspection failure (status 1)" "$TMP_DIR/lsof-status-one-start.log"; then
  echo "lsof exit-1 inspection error did not preserve its port, status, and cause" >&2
  cat "$TMP_DIR/lsof-status-one-start.log" >&2
  exit 1
fi
[[ ! -e "$STATE_DIR" ]] || {
  echo "lsof exit-1 inspection error left development session metadata behind" >&2
  exit 1
}
kill -0 "$LISTENER_PID" 2>/dev/null || {
  echo "lsof exit-1 inspection error killed an unowned listener" >&2
  exit 1
}

if PATH="$LSOF_MOCK_BIN:$PATH" GEOROIDS_CONTRACT_MODE=port-inspection-status-one \
  GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" status >"$TMP_DIR/lsof-status-one-status.log" 2>&1; then
  echo "dev-server status unexpectedly reported success after lsof exit-1 inspection error" >&2
  exit 1
fi
if ! grep -q "Could not inspect TCP port" "$TMP_DIR/lsof-status-one-status.log" || \
  ! grep -q "exit 1" "$TMP_DIR/lsof-status-one-status.log" || \
  ! grep -q "simulated lsof inspection failure (status 1)" "$TMP_DIR/lsof-status-one-status.log"; then
  echo "lsof exit-1 status failure did not preserve its port, status, and cause" >&2
  cat "$TMP_DIR/lsof-status-one-status.log" >&2
  exit 1
fi
kill -0 "$LISTENER_PID" 2>/dev/null || {
  echo "lsof exit-1 status failure killed an unowned listener" >&2
  exit 1
}
kill "$LISTENER_PID" 2>/dev/null || true
wait "$LISTENER_PID" 2>/dev/null || true
LISTENER_PID=""

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

start_owned_process() {
  rm -f "$OWNED_PID_FILE" "$OWNED_CHILD_PID_FILE"
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
}

record_owned_state() {
  mkdir "$STATE_DIR"
  printf '%s\n' "$OWNED_PID" >"$STATE_DIR/pid"
  ps -p "$OWNED_PID" -o lstart= | sed 's/^ *//' >"$STATE_DIR/start"
  printf '%s\n' "$ROOT" >"$STATE_DIR/root"
}

mkdir -p "$PS_MOCK_BIN"
cat >"$PS_MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "${GEOROIDS_CONTRACT_MODE:-}" == process-command-status-one ]] && [[ " $* " == *" command="* ]]; then
  echo "simulated ps command inspection failure (status 1)" >&2
  exit 1
fi
exec "$GEOROIDS_CONTRACT_REAL_PS" "$@"
EOF
chmod +x "$PS_MOCK_BIN/ps"

start_owned_process
record_owned_state
if PATH="$LSOF_MOCK_BIN:$PATH" GEOROIDS_CONTRACT_MODE=process-cwd-status-one \
  GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-cwd-status-one.log" 2>&1; then
  echo "dev-server unexpectedly trusted a cwd inspection error" >&2
  exit 1
fi
if ! grep -q "Could not inspect cwd for process PID" "$TMP_DIR/process-cwd-status-one.log" || \
  ! grep -q "exit 1" "$TMP_DIR/process-cwd-status-one.log" || \
  ! grep -q "simulated lsof cwd inspection failure (status 1)" "$TMP_DIR/process-cwd-status-one.log"; then
  echo "lsof cwd exit-1 inspection error did not preserve its PID, status, and cause" >&2
  cat "$TMP_DIR/process-cwd-status-one.log" >&2
  exit 1
fi
[[ -d "$STATE_DIR" ]] || {
  echo "lsof cwd exit-1 inspection error removed session metadata" >&2
  exit 1
}
kill -0 "$OWNED_PID" 2>/dev/null || {
  echo "lsof cwd exit-1 inspection error signaled the owned process" >&2
  exit 1
}

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-cwd-status-one-recovery.log" 2>&1; then
  echo "dev-server failed to recover after cwd inspection failure" >&2
  cat "$TMP_DIR/process-cwd-status-one-recovery.log" >&2
  exit 1
fi
owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "cwd-inspection recovery owned root"
assert_process_stopped "$owned_child_pid" "cwd-inspection recovery owned child"
[[ ! -e "$STATE_DIR" ]] || {
  echo "cwd-inspection recovery left session metadata behind" >&2
  exit 1
}
OWNED_PID=""

start_owned_process
record_owned_state
if PATH="$PS_MOCK_BIN:$PATH" GEOROIDS_CONTRACT_MODE=process-command-status-one \
  GEOROIDS_CONTRACT_REAL_PS="$REAL_PS" \
  GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-command-status-one.log" 2>&1; then
  echo "dev-server unexpectedly trusted a ps command inspection error" >&2
  exit 1
fi
if ! grep -q "Could not inspect command for PID" "$TMP_DIR/process-command-status-one.log" || \
  ! grep -q "exit 1" "$TMP_DIR/process-command-status-one.log" || \
  ! grep -q "simulated ps command inspection failure (status 1)" "$TMP_DIR/process-command-status-one.log"; then
  echo "ps command exit-1 inspection error did not preserve its PID, status, and cause" >&2
  cat "$TMP_DIR/process-command-status-one.log" >&2
  exit 1
fi
[[ -d "$STATE_DIR" ]] || {
  echo "ps command exit-1 inspection error removed session metadata" >&2
  exit 1
}
kill -0 "$OWNED_PID" 2>/dev/null || {
  echo "ps command exit-1 inspection error signaled the owned process" >&2
  exit 1
}

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-command-status-one-recovery.log" 2>&1; then
  echo "dev-server failed to recover after ps command inspection failure" >&2
  cat "$TMP_DIR/process-command-status-one-recovery.log" >&2
  exit 1
fi
owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "command-inspection recovery owned root"
assert_process_stopped "$owned_child_pid" "command-inspection recovery owned child"
[[ ! -e "$STATE_DIR" ]] || {
  echo "command-inspection recovery left session metadata behind" >&2
  exit 1
}
OWNED_PID=""

start_owned_process
record_owned_state

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

start_owned_process
record_owned_state
printf '%s\n' 'fixture marker' >"$STATE_DIR/unexpected"

if GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/state-removal-failure.log" 2>&1; then
  echo "dev-server unexpectedly reported success after metadata removal failed" >&2
  exit 1
fi
if ! grep -q "Could not remove development session metadata" "$TMP_DIR/state-removal-failure.log"; then
  echo "state-removal failure did not explain the cleanup failure" >&2
  cat "$TMP_DIR/state-removal-failure.log" >&2
  exit 1
fi
owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "state-removal-failure owned root"
assert_process_stopped "$owned_child_pid" "state-removal-failure owned child"
[[ -d "$STATE_DIR" ]] || {
  echo "state-removal failure unexpectedly removed the metadata directory" >&2
  exit 1
}
rm -f "$STATE_DIR/unexpected"
"$REAL_RMDIR" "$STATE_DIR"
OWNED_PID=""

mkdir -p "$MOCK_BIN"
cat >"$MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
exit 2
EOF
chmod +x "$MOCK_BIN/ps"

start_owned_process
record_owned_state
if PATH="$MOCK_BIN:$PATH" GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" start >"$TMP_DIR/ownership-inspection-start-failure.log" 2>&1; then
  echo "dev-server unexpectedly replaced metadata after ownership inspection failed" >&2
  exit 1
fi
if ! grep -q "Could not verify the existing GeoRoids development session" "$TMP_DIR/ownership-inspection-start-failure.log"; then
  echo "ownership-inspection start failure did not explain the refusal" >&2
  cat "$TMP_DIR/ownership-inspection-start-failure.log" >&2
  exit 1
fi
[[ -d "$STATE_DIR" ]] || {
  echo "ownership-inspection start failure removed session metadata" >&2
  exit 1
}
kill -0 "$OWNED_PID" 2>/dev/null || {
  echo "ownership-inspection start failure did not leave the owned process running" >&2
  exit 1
}

if PATH="$MOCK_BIN:$PATH" GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/ownership-inspection-stop-failure.log" 2>&1; then
  echo "dev-server unexpectedly signaled a process after ownership inspection failed" >&2
  exit 1
fi
if ! grep -q "Could not verify the recorded GeoRoids development session" "$TMP_DIR/ownership-inspection-stop-failure.log"; then
  echo "ownership-inspection stop failure did not explain the refusal" >&2
  cat "$TMP_DIR/ownership-inspection-stop-failure.log" >&2
  exit 1
fi
[[ -d "$STATE_DIR" ]] || {
  echo "ownership-inspection stop failure removed session metadata" >&2
  exit 1
}
kill -0 "$OWNED_PID" 2>/dev/null || {
  echo "ownership-inspection stop failure signaled the owned process" >&2
  exit 1
}

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/ownership-inspection-recovery.log" 2>&1; then
  echo "dev-server failed to recover after ownership inspection failures" >&2
  cat "$TMP_DIR/ownership-inspection-recovery.log" >&2
  exit 1
fi
owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "ownership-inspection recovery owned root"
assert_process_stopped "$owned_child_pid" "ownership-inspection recovery owned child"
[[ ! -e "$STATE_DIR" ]] || {
  echo "ownership-inspection recovery left session metadata behind" >&2
  exit 1
}
OWNED_PID=""

mkdir -p "$PGREP_MOCK_BIN"
cat >"$PGREP_MOCK_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
if [[ ! -e "$GEOROIDS_CONTRACT_PGREP_FAILURE_MARKER" ]]; then
  : >"$GEOROIDS_CONTRACT_PGREP_FAILURE_MARKER"
  exit 2
fi
exec "$GEOROIDS_CONTRACT_REAL_PGREP" "$@"
EOF
chmod +x "$PGREP_MOCK_BIN/pgrep"

start_owned_process
record_owned_state
if PATH="$PGREP_MOCK_BIN:$PATH" GEOROIDS_CONTRACT_REAL_PGREP="$(command -v pgrep)" \
  GEOROIDS_CONTRACT_PGREP_FAILURE_MARKER="$TMP_DIR/pgrep-failure-seen" \
  GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-tree-failure-stop.log" 2>&1; then
  echo "dev-server unexpectedly reported success after process-tree inspection failed" >&2
  exit 1
fi
if ! grep -q "Could not enumerate children of owned process PID" "$TMP_DIR/process-tree-failure-stop.log"; then
  echo "process-tree failure did not explain the cleanup refusal" >&2
  cat "$TMP_DIR/process-tree-failure-stop.log" >&2
  exit 1
fi
[[ -d "$STATE_DIR" ]] || {
  echo "process-tree failure removed session metadata" >&2
  exit 1
}
kill -0 "$OWNED_PID" 2>/dev/null || {
  echo "process-tree failure signaled the owned process" >&2
  exit 1
}

if ! GEOROIDS_DEV_VITE_PORT="$VITE_PORT" GEOROIDS_DEV_SERVER_PORT="$SERVER_PORT" \
  "$RUNNER" stop >"$TMP_DIR/process-tree-failure-recovery.log" 2>&1; then
  echo "dev-server failed to recover after process-tree inspection failure" >&2
  cat "$TMP_DIR/process-tree-failure-recovery.log" >&2
  exit 1
fi
owned_child_pid="$(<"$OWNED_CHILD_PID_FILE")"
wait "$OWNED_REAPER_PID" 2>/dev/null || true
OWNED_REAPER_PID=""
assert_process_stopped "$OWNED_PID" "process-tree failure recovery owned root"
assert_process_stopped "$owned_child_pid" "process-tree failure recovery owned child"
[[ ! -e "$STATE_DIR" ]] || {
  echo "process-tree failure recovery left session metadata behind" >&2
  exit 1
}
OWNED_PID=""

echo "dev-server contract passed: occupied ports and untrusted PIDs are refused; owned trees are stopped"
