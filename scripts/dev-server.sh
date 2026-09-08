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
    lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1
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
    ps -p "$1" -o command= 2>/dev/null | sed 's/^ *//'
}

process_cwd() {
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
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
    [ -d "$STATE_DIR" ] || return 1
    [ -f "$PID_FILE" ] && [ -f "$START_FILE" ] && [ -f "$ROOT_FILE" ] || return 1
    valid_pid "$pid" || return 1
    IFS= read -r expected_start < "$START_FILE" || return 1
    IFS= read -r expected_root < "$ROOT_FILE" || return 1
    [ "$expected_root" = "$ROOT" ] || return 1
    [ "$(process_start "$pid")" = "$expected_start" ] || return 1
    [ "$(process_cwd "$pid")" = "$ROOT" ] || return 1
    case "$(process_command "$pid")" in
        *concurrently*) return 0 ;;
        *) return 1 ;;
    esac
}

remove_state() {
    rm -f "$PID_FILE" "$START_FILE" "$ROOT_FILE"
    rmdir "$STATE_DIR" 2>/dev/null || true
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
        remove_state
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
    port_in_use "$DEV_SERVER_PORT" && occupied+=("$DEV_SERVER_PORT")
    port_in_use "$DEV_VITE_PORT" && occupied+=("$DEV_VITE_PORT")
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
    existing_pid="$(read_state_pid)"
    if state_is_owned "$existing_pid"; then
        echo "❌ GeoRoids development servers are already running for this checkout (PID $existing_pid)." >&2
        echo "   Stop them with: npm run dev:kill" >&2
        return 1
    fi
    if [ -n "$existing_pid" ]; then
        echo "⚠️  Removing stale GeoRoids development session metadata for PID $existing_pid." >&2
    fi
    remove_state
    if ! mkdir "$STATE_DIR" 2>/dev/null; then
        echo "❌ Could not claim the GeoRoids development session for this checkout" >&2
        return 1
    fi
    STATE_HELD=true
}

write_state() {
    local start_time
    start_time="$(process_start "$DEV_PID")"
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
    pid="$(read_state_pid)"
    if state_is_owned "$pid"; then
        echo "✅ GeoRoids development session is running (PID $pid)"
        echo "   Vite:    http://localhost:$DEV_VITE_PORT"
        echo "   Server:  http://localhost:$DEV_SERVER_PORT"
        return 0
    fi
    if [ -d "$STATE_DIR" ]; then
        echo "⚠️  Stale or untrusted GeoRoids development metadata: $STATE_DIR" >&2
        return 1
    fi
    if port_in_use "$DEV_SERVER_PORT" || port_in_use "$DEV_VITE_PORT"; then
        echo "⚠️  A development port is occupied by an unowned process; GeoRoids is not running from this checkout." >&2
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
    pid="$(read_state_pid)"
    if ! state_is_owned "$pid"; then
        echo "❌ Refusing to signal an untrusted development PID; inspect or remove stale metadata after confirming it is safe: $STATE_DIR" >&2
        return 1
    fi
    echo "🧹 Stopping GeoRoids development session (PID $pid)..."
    terminate_process_tree "$pid"
    remove_state
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
            "vite --port $DEV_VITE_PORT --strictPort" \
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
