#!/usr/bin/env bash

# Run integration tests with one repository-wide owner at a time. The lock lives
# in Git's common directory so linked worktrees sharing ports 3001/5173 also
# share the same serialization boundary.
set -uo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "❌ test-runner.sh must be launched from a Git worktree" >&2
    exit 1
fi

if ! GIT_COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"; then
    echo "❌ Could not locate the repository's common Git directory" >&2
    exit 1
fi

case "$GIT_COMMON_DIR" in
    /*) ;;
    *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
esac

cd "$REPO_ROOT" || {
    echo "❌ Could not enter the repository worktree" >&2
    exit 1
}

valid_port() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

TEST_VITE_PORT="${GEOROIDS_TEST_VITE_PORT:-5173}"
TEST_SERVER_PORT="${GEOROIDS_TEST_SERVER_PORT:-3001}"
if ! valid_port "$TEST_VITE_PORT" || ! valid_port "$TEST_SERVER_PORT"; then
    echo "❌ GEOROIDS_TEST_VITE_PORT and GEOROIDS_TEST_SERVER_PORT must be valid TCP ports" >&2
    exit 1
fi

# Integration helpers read these values so a linked worktree can run against
# its own Vite/server pair while another checkout owns the default ports.
export GEOROIDS_TEST_VITE_PORT="$TEST_VITE_PORT"
export GEOROIDS_TEST_SERVER_PORT="$TEST_SERVER_PORT"

LOCK_DIR="$GIT_COMMON_DIR/georoids-test-runner.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_WORKTREE_FILE="$LOCK_DIR/worktree"
LOCK_COMMAND_FILE="$LOCK_DIR/command"

LOCK_HELD=false
DEV_PID=""
TEST_PID=""
CLEANUP_RUNNING=false

read_lock_pid() {
    local lock_pid=""
    if [ -f "$LOCK_PID_FILE" ]; then
        IFS= read -r lock_pid < "$LOCK_PID_FILE" || true
    fi
    printf '%s' "$lock_pid"
}

read_lock_worktree() {
    local lock_worktree="unknown worktree"
    if [ -f "$LOCK_WORKTREE_FILE" ]; then
        IFS= read -r lock_worktree < "$LOCK_WORKTREE_FILE" || true
    fi
    printf '%s' "$lock_worktree"
}

valid_pid() {
    case "${1:-}" in
        ''|0|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

is_protected_vitest_option() {
    case "${1:-}" in
        -c*|--config|--config=*|\
        --pool|--pool=*|--pool-options|--pool-options=*|--pool-options.*|--poolOptions|--poolOptions=*|--poolOptions.*|\
        --maxWorkers|--maxWorkers=*|--max-workers|--max-workers=*|\
        --maxConcurrency|--maxConcurrency=*|--max-concurrency|--max-concurrency=*|\
        --isolate|--isolate=*|--no-isolate|--no-isolate=*|\
        --fileParallelism|--fileParallelism=*|--file-parallelism|--file-parallelism=*|\
        --no-fileParallelism|--no-fileParallelism=*|--no-file-parallelism|--no-file-parallelism=*|\
        --sequence|--sequence=*|--sequence.*|--sequence-* )
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

reject_protected_vitest_arguments() {
    local arg
    for arg in "$@"; do
        if is_protected_vitest_option "$arg"; then
            echo "❌ $arg is reserved by test-runner.sh; Vitest's serialized settings cannot be overridden." >&2
            echo "   Pass test paths and non-runner options such as --reporter only." >&2
            return 1
        fi
    done
    return 0
}

write_lock_metadata() {
    if ! printf '%s\n' "$$" > "$LOCK_PID_FILE" || \
        ! printf '%s\n' "$REPO_ROOT" > "$LOCK_WORKTREE_FILE" || \
        ! printf '%s\n' "$*" > "$LOCK_COMMAND_FILE"; then
        echo "❌ Could not write test-runner lock metadata" >&2
        rm -f "$LOCK_PID_FILE" "$LOCK_WORKTREE_FILE" "$LOCK_COMMAND_FILE"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        return 1
    fi
    return 0
}

acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_HELD=true
        if ! write_lock_metadata "$@"; then
            LOCK_HELD=false
            return 1
        fi
        return 0
    fi

    local owner_pid
    owner_pid="$(read_lock_pid)"
    if valid_pid "$owner_pid" && kill -0 "$owner_pid" 2>/dev/null; then
        echo "❌ Another GeoRoids test runner is already running (PID $owner_pid)." >&2
        echo "   Worktree: $(read_lock_worktree)" >&2
        echo "   Lock: $LOCK_DIR" >&2
        return 1
    fi

    if valid_pid "$owner_pid"; then
        echo "⚠️  Removing stale test-runner lock for dead PID $owner_pid." >&2
        rm -f "$LOCK_PID_FILE" "$LOCK_WORKTREE_FILE" "$LOCK_COMMAND_FILE"
        if ! rmdir "$LOCK_DIR" 2>/dev/null; then
            echo "❌ Could not remove stale test-runner lock: $LOCK_DIR" >&2
            return 1
        fi
        if ! mkdir "$LOCK_DIR" 2>/dev/null; then
            echo "❌ Test-runner lock changed while recovering the stale lock" >&2
            return 1
        fi
        LOCK_HELD=true
        if ! write_lock_metadata "$@"; then
            LOCK_HELD=false
            return 1
        fi
        return 0
    fi

    echo "❌ Test-runner lock exists but has no trustworthy owner." >&2
    echo "   Confirm no GeoRoids tests are running, then remove: $LOCK_DIR" >&2
    return 1
}

release_lock() {
    if [ "$LOCK_HELD" != true ]; then
        return 0
    fi

    if [ "$(read_lock_pid)" != "$$" ]; then
        echo "⚠️  Test-runner lock ownership changed; leaving the current lock untouched: $LOCK_DIR" >&2
        LOCK_HELD=false
        return 0
    fi

    rm -f "$LOCK_PID_FILE" "$LOCK_WORKTREE_FILE" "$LOCK_COMMAND_FILE"
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
        echo "⚠️  Could not remove test-runner lock directory: $LOCK_DIR" >&2
    fi
    LOCK_HELD=false
}

# Kill only descendants of a process started by this runner. This keeps a
# failed browser/Vitest run from leaking its own children without inspecting or
# signalling processes belonging to another worktree or application.
terminate_process_tree() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0
    [ "$pid" != "$$" ] || return 1

    local child
    local children
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    for child in $children; do
        terminate_process_tree "$child"
    done

    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 0.1
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
}

cleanup() {
    local exit_code=$?
    if [ "$CLEANUP_RUNNING" = true ]; then
        exit "$exit_code"
    fi
    CLEANUP_RUNNING=true
    trap - EXIT INT TERM

    if [ -n "$TEST_PID" ]; then
        terminate_process_tree "$TEST_PID"
        TEST_PID=""
    fi
    if [ -n "$DEV_PID" ]; then
        terminate_process_tree "$DEV_PID"
        DEV_PID=""
    fi
    release_lock
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

servers_ready() {
    curl -sf "http://localhost:$TEST_VITE_PORT/" > /dev/null 2>&1 && \
        curl -sf "http://localhost:$TEST_SERVER_PORT/health" > /dev/null 2>&1
}

port_in_use() {
    lsof -nP -iTCP:"$1" -sTCP:LISTEN > /dev/null 2>&1
}

wait_for_servers() {
    local retries=0
    while [ "$retries" -lt 20 ]; do
        if servers_ready; then
            echo "✅ Dev servers are running"
            return 0
        fi
        retries=$((retries + 1))
        echo "⏳ Waiting for servers... (attempt $retries/20)"
        sleep 2
    done
    return 1
}

ensure_env_local() {
    if [ -f .env.local ]; then
        return 0
    fi
    if [ -f .env.example ] && cp .env.example .env.local; then
        echo "📋 Created .env.local from .env.example"
        return 0
    fi
    echo "❌ .env.local is missing and .env.example could not be copied" >&2
    return 1
}

prepare_logs() {
    mkdir -p logs || return 1
    rm -f logs/client.log logs/server.log
    touch logs/client.log logs/server.log
}

start_dev_servers() {
    echo "🔍 Checking that test ports are available..."

    if ! command -v lsof > /dev/null 2>&1; then
        echo "❌ lsof is required to verify that test ports are owned by this runner" >&2
        return 1
    fi

    local occupied_ports=()
    if port_in_use "$TEST_VITE_PORT"; then
        occupied_ports+=("$TEST_VITE_PORT")
    fi
    if port_in_use "$TEST_SERVER_PORT"; then
        occupied_ports+=("$TEST_SERVER_PORT")
    fi
    if [ "${#occupied_ports[@]}" -gt 0 ]; then
        echo "❌ Test port(s) ${occupied_ports[*]} are already in use; refusing to attach to unowned services." >&2
        echo "   Stop the owning process after confirming it is safe, or choose unused ports with:" >&2
        echo "   GEOROIDS_TEST_VITE_PORT=<port> GEOROIDS_TEST_SERVER_PORT=<port> ./scripts/test-runner.sh ..." >&2
        return 1
    fi

    ensure_env_local || return 1
    prepare_logs || {
        echo "❌ Could not prepare test logs" >&2
        return 1
    }

    echo "🚀 Starting dev servers owned by this runner..."
    (
        export NODE_ENV=development
        export VITEST=false
        export PORT="$TEST_SERVER_PORT"
        export VITE_WEBSOCKET_URL="ws://localhost:$TEST_SERVER_PORT/ws"
        exec npx --no-install concurrently \
            --kill-others \
            --prefix-colors "blue.bold,green.bold" \
            --prefix "[{name}]" \
            --names "vite,network" \
            "vite --port $TEST_VITE_PORT --strictPort" \
            "tsx --env-file=.env.local server.ts"
    ) &
    DEV_PID=$!

    if ! wait_for_servers; then
        echo "❌ Failed to start dev servers" >&2
        return 1
    fi
}

contains_browser_path() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            *tests/integration/browser|*tests/integration/browser/*) return 0 ;;
        esac
    done
    return 1
}

run_tests() {
    local -a test_args=("$@")
    local vitest_config="vitest.config.ts"
    if contains_browser_path "${test_args[@]}"; then
        vitest_config="vitest.browser.config.ts"
    fi

    local -a vitest_command=(
        npx --no-install vitest run
        --config "$vitest_config"
        --pool=forks
        --maxWorkers=1
        --sequence.concurrent=false
        --maxConcurrency=1
        --isolate=true
        --fileParallelism=false
    )

    echo "🧪 Running tests with repository-scoped single-instance protection..."
    printf '%s' "📝 Test arguments:"
    if [ "${#test_args[@]}" -gt 0 ]; then
        printf ' %q' "${test_args[@]}"
    fi
    printf '\n📝 Vitest config: %s\n' "$vitest_config"

    VITEST_MAX_WORKERS=1 "${vitest_command[@]}" "${test_args[@]}" &
    TEST_PID=$!
    wait "$TEST_PID"
    local exit_code=$?
    TEST_PID=""

    if [ "$exit_code" -eq 0 ]; then
        echo "✅ Tests completed successfully"
    else
        echo "❌ Tests failed with exit code $exit_code"
    fi
    return "$exit_code"
}

main() {
    local -a test_args=("$@")

    if ! reject_protected_vitest_arguments "${test_args[@]}"; then
        exit 64
    fi

    echo "🧪 Starting GeoRoids test runner..."
    if ! acquire_lock "${test_args[@]}"; then
        exit 1
    fi

    if ! start_dev_servers; then
        exit 1
    fi

    run_tests "${test_args[@]}"
    return $?
}

main "$@"
