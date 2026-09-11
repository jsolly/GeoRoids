#!/usr/bin/env bash
# Start, inspect, or stop the GeoRoids development session for this checkout.
#
# The session record is keyed by the absolute repository path. We never search
# for or signal arbitrary `vite`, `tsx`, or port-owning processes: a developer
# may have another checkout or application running at the same time.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/process-tree.sh
source "$ROOT/scripts/process-tree.sh"

DEV_VITE_PORT="${GEOROIDS_DEV_VITE_PORT:-5173}"
DEV_SERVER_PORT="${GEOROIDS_DEV_SERVER_PORT:-3001}"
SESSION_KEY="$(printf '%s:%s:%s' "$ROOT" "$DEV_VITE_PORT" "$DEV_SERVER_PORT" | shasum -a 256 | cut -c1-16)"
STATE_DIR="${TMPDIR:-/tmp}/georoids-dev-${SESSION_KEY}"
PID_FILE="$STATE_DIR/pid"
START_FILE="$STATE_DIR/start"
ROOT_FILE="$STATE_DIR/root"
DEV_PID=""
STATE_HELD=false
CLEANUP_RUNNING=false

usage() {
    cat <<'EOF'
Usage: ./scripts/dev-server.sh [start|--stop|--status]

start   Start Vite and the WebSocket server after verifying their ports are free.
--stop  Stop only the process tree recorded for this checkout.
--status Show the recorded session and the two development ports.
EOF
}

valid_port() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

port_in_use() {
    local port="$1"
    local lsof_status=0
    if process_inspect lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
        return 0
    else
        lsof_status=$?
    fi
    if [ "$lsof_status" -gt 1 ]; then
        report_process_inspection_failure "TCP port" lsof "$port"
    fi
    return "$lsof_status"
}

require_process_tools() {
    local required_command
    for required_command in lsof pgrep ps; do
        if ! command -v "$required_command" > /dev/null 2>&1; then
            echo "❌ $required_command is required to identify owned development ports and processes" >&2
            return 1
        fi
    done
    if ! valid_port "$DEV_VITE_PORT" || ! valid_port "$DEV_SERVER_PORT"; then
        echo "❌ GEOROIDS_DEV_VITE_PORT and GEOROIDS_DEV_SERVER_PORT must be valid TCP ports" >&2
        return 1
    fi
}

process_command() {
    local output
    local ps_status
    if process_inspect ps -p "$1" -o command=; then
        output="$PROCESS_INSPECTION_OUTPUT"
        printf '%s\n' "$output" | sed 's/^ *//'
        return 0
    else
        ps_status=$?
    fi
    if [ "$ps_status" -eq 1 ]; then
        return 0
    fi
    report_process_inspection_failure "command for PID" ps "$1"
    return "$ps_status"
}

process_cwd() {
    local output
    local lsof_status
    if process_inspect lsof -a -p "$1" -d cwd -Fn; then
        output="$PROCESS_INSPECTION_OUTPUT"
        printf '%s\n' "$output" | sed -n 's/^n//p'
        return 0
    else
        lsof_status=$?
    fi
    if [ "$lsof_status" -eq 1 ]; then
        return 0
    fi
    report_process_inspection_failure "cwd for process PID" lsof "$1"
    return "$lsof_status"
}

read_state_pid() {
    local pid=""
    if [ -f "$PID_FILE" ]; then
        IFS= read -r pid < "$PID_FILE" || true
    fi
    printf '%s' "$pid"
}

state_is_owned() {
    local pid="${1:-}"
    local expected_start=""
    local expected_root=""
    local actual_start=""
    local actual_cwd=""
    local command=""
    [ -d "$STATE_DIR" ] || return 1
    [ -f "$PID_FILE" ] && [ -f "$START_FILE" ] && [ -f "$ROOT_FILE" ] || return 1
    valid_pid "$pid" || return 1
    IFS= read -r expected_start < "$START_FILE" || return 1
    IFS= read -r expected_root < "$ROOT_FILE" || return 1
    [ "$expected_root" = "$ROOT" ] || return 1
    actual_start="$(process_start "$pid")" || return $?
    [ "$actual_start" = "$expected_start" ] || return 1
    actual_cwd="$(process_cwd "$pid")" || return $?
    [ "$actual_cwd" = "$ROOT" ] || return 1
    command="$(process_command "$pid")" || return $?
    case "$command" in
        *concurrently*) return 0 ;;
        *) return 1 ;;
    esac
}

remove_state() {
    if ! rm -f "$PID_FILE" "$START_FILE" "$ROOT_FILE"; then
        echo "❌ Could not remove development session metadata: $STATE_DIR" >&2
        return 1
    fi
    if [ -d "$STATE_DIR" ] && ! rmdir "$STATE_DIR" 2>/dev/null; then
        echo "❌ Could not remove development session metadata: $STATE_DIR" >&2
        return 1
    fi
    if [ -e "$STATE_DIR" ]; then
        echo "❌ Development session metadata remains after cleanup: $STATE_DIR" >&2
        return 1
    fi
}

cleanup() {
    local exit_code=$?
    if [ "$CLEANUP_RUNNING" = true ]; then
        exit "$exit_code"
    fi
    CLEANUP_RUNNING=true
    trap - EXIT INT TERM

    if [ -n "$DEV_PID" ]; then
        terminate_process_tree "$DEV_PID" || exit_code=1
        DEV_PID=""
    fi
    if [ "$STATE_HELD" = true ]; then
        if ! remove_state && [ "$exit_code" -eq 0 ]; then
            exit_code=1
        fi
        STATE_HELD=false
    fi
    exit "$exit_code"
}

on_interrupt() {
    exit 130
}

on_terminate() {
    exit 143
}

trap cleanup EXIT
trap on_interrupt INT
trap on_terminate TERM

ensure_env_local() {
    if [ -f .env.local ]; then
        return 0
    fi
    if [ -f .env.example ]; then
        cp .env.example .env.local
        echo "📋 Created .env.local from .env.example"
        return 0
    fi
    cat > .env.local <<'EOF'
NODE_ENV=development
PORT=3001
VITEST=false
EOF
    echo "📋 Created default .env.local"
}

prepare_logs() {
    mkdir -p logs
    rm -f logs/client.log logs/server.log
    touch logs/client.log logs/server.log
}

check_ports_free() {
    local occupied=()
    local port
    local port_status
    for port in "$DEV_SERVER_PORT" "$DEV_VITE_PORT"; do
        port_status=0
        port_in_use "$port" || port_status=$?
        case "$port_status" in
            0) occupied+=("$port") ;;
            1) ;;
            *) return "$port_status" ;;
        esac
    done
    if [ "${#occupied[@]}" -gt 0 ]; then
        echo "❌ Development port(s) ${occupied[*]} are already in use; refusing to stop or attach to unowned processes." >&2
        echo "   Inspect the owner with: lsof -nP -iTCP:${occupied[0]} -sTCP:LISTEN" >&2
        return 1
    fi
}

acquire_state() {
    if mkdir "$STATE_DIR" 2>/dev/null; then
        STATE_HELD=true
        return 0
    fi

    local existing_pid
    local ownership_status
    existing_pid="$(read_state_pid)"
    if state_is_owned "$existing_pid"; then
        echo "❌ GeoRoids development servers are already running for this checkout (PID $existing_pid)." >&2
        echo "   Stop them with: npm run dev:kill" >&2
        return 1
    else
        ownership_status=$?
        if [ "$ownership_status" -gt 1 ]; then
            echo "❌ Could not verify the existing GeoRoids development session; refusing to replace its metadata" >&2
            return "$ownership_status"
        fi
    fi
    if [ -n "$existing_pid" ]; then
        echo "⚠️  Removing stale GeoRoids development session metadata for PID $existing_pid." >&2
    fi
    if ! remove_state; then
        echo "❌ Could not recover the stale GeoRoids development session metadata" >&2
        return 1
    fi
    if ! mkdir "$STATE_DIR" 2>/dev/null; then
        echo "❌ Could not claim the GeoRoids development session for this checkout" >&2
        return 1
    fi
    STATE_HELD=true
}

write_state() {
    local start_time
    local ps_status
    start_time="$(process_start "$DEV_PID")" || {
        ps_status=$?
        echo "❌ Could not inspect the owned development process start time (ps exited $ps_status)" >&2
        return "$ps_status"
    }
    [ -n "$start_time" ] || {
        echo "❌ Could not determine the owned development process start time" >&2
        return 1
    }
    printf '%s\n' "$DEV_PID" > "$PID_FILE"
    printf '%s\n' "$start_time" > "$START_FILE"
    printf '%s\n' "$ROOT" > "$ROOT_FILE"
}

status() {
    require_process_tools
    local pid
    local ownership_status
    pid="$(read_state_pid)"
    if state_is_owned "$pid"; then
        echo "✅ GeoRoids development session is running (PID $pid)"
        echo "   Vite:    http://localhost:$DEV_VITE_PORT"
        echo "   Server:  http://localhost:$DEV_SERVER_PORT"
        return 0
    else
        ownership_status=$?
        if [ "$ownership_status" -gt 1 ]; then
            echo "❌ Could not verify the recorded GeoRoids development session" >&2
            return "$ownership_status"
        fi
    fi
    if [ -d "$STATE_DIR" ]; then
        echo "⚠️  Stale or untrusted GeoRoids development metadata: $STATE_DIR" >&2
        return 1
    fi
    local occupied=()
    local port
    local port_status
    for port in "$DEV_SERVER_PORT" "$DEV_VITE_PORT"; do
        port_status=0
        port_in_use "$port" || port_status=$?
        case "$port_status" in
            0) occupied+=("$port") ;;
            1) ;;
            *) return "$port_status" ;;
        esac
    done
    if [ "${#occupied[@]}" -gt 0 ]; then
        echo "⚠️  Development port(s) ${occupied[*]} are occupied by unowned processes; GeoRoids is not running from this checkout." >&2
        return 1
    fi
    echo "✅ No GeoRoids development session is running for this checkout"
}

stop() {
    require_process_tools
    if [ ! -d "$STATE_DIR" ]; then
        echo "✅ No GeoRoids development session is recorded for this checkout"
        return 0
    fi

    local pid
    local ownership_status
    pid="$(read_state_pid)"
    ownership_status=0
    state_is_owned "$pid" || ownership_status=$?
    if [ "$ownership_status" -gt 1 ]; then
        echo "❌ Could not verify the recorded GeoRoids development session; refusing to signal it" >&2
        return "$ownership_status"
    fi
    if [ "$ownership_status" -ne 0 ]; then
        echo "❌ Refusing to signal an untrusted development PID; inspect or remove stale metadata after confirming it is safe: $STATE_DIR" >&2
        return 1
    fi
    echo "🧹 Stopping GeoRoids development session (PID $pid)..."
    if ! terminate_process_tree "$pid"; then
        echo "❌ Could not stop the recorded GeoRoids development process; leaving session metadata in place" >&2
        return 1
    fi
    if ! remove_state; then
        return 1
    fi
    echo "✅ GeoRoids development session stopped"
}

start() {
    require_process_tools
    acquire_state
    check_ports_free
    ensure_env_local
    prepare_logs

    echo "✅ Development ports are free; starting GeoRoids servers..."
    (
        export NODE_ENV=development
        export VITEST=false
        export PORT="$DEV_SERVER_PORT"
        export VITE_WEBSOCKET_URL="ws://localhost:$DEV_SERVER_PORT/ws"
        exec npx --no-install concurrently \
            --kill-others \
            --prefix-colors "blue.bold,green.bold" \
            --prefix "[{name}]" \
            --names "vite,network" \
            "vite --configLoader runner --port $DEV_VITE_PORT --strictPort" \
            "tsx --env-file=.env.local server.ts"
    ) &
    DEV_PID=$!
    write_state
    echo "🚀 GeoRoids development servers started (PID $DEV_PID)"
    wait "$DEV_PID"
}

main() {
    local mode="${1:-start}"
    case "$mode" in
        start) [ "$#" -le 1 ] || { usage >&2; return 64; }; start ;;
        stop|--stop) [ "$#" -eq 1 ] || { usage >&2; return 64; }; stop ;;
        status|--status) [ "$#" -eq 1 ] || { usage >&2; return 64; }; status ;;
        -h|--help) usage ;;
        *) usage >&2; return 64 ;;
    esac
}

main "$@"
