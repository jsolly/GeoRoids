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

# shellcheck source=scripts/process-tree.sh
source "$REPO_ROOT/scripts/process-tree.sh"

valid_port() {
    case "${1:-}" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

valid_positive_integer() {
    case "${1:-}" in
        ''|*[!0-9]*|0) return 1 ;;
        *) return 0 ;;
    esac
}

TEST_VITE_PORT="${GEOROIDS_TEST_VITE_PORT:-5173}"
TEST_SERVER_PORT="${GEOROIDS_TEST_SERVER_PORT:-3001}"
MAX_TEST_DURATION_SECONDS="${GEOROIDS_TEST_MAX_DURATION_SECONDS:-1200}"
RUN_MODE=tests
BUILD_MODE="${GEOROIDS_TEST_BUILD:-development}"
case "${1:-}" in
    --benchmark-client) RUN_MODE=benchmark-client; BUILD_MODE=production; shift ;;
    --benchmark-load) RUN_MODE=benchmark-load; BUILD_MODE=production; shift ;;
esac
RUNNER_ARGS=("$@")
case "$BUILD_MODE" in
    development|production) ;;
    *) echo "GEOROIDS_TEST_BUILD must be development or production" >&2; exit 64 ;;
esac
if ! valid_port "$TEST_VITE_PORT" || ! valid_port "$TEST_SERVER_PORT"; then
    echo "❌ GEOROIDS_TEST_VITE_PORT and GEOROIDS_TEST_SERVER_PORT must be valid TCP ports" >&2
    exit 1
fi
if ! valid_positive_integer "$MAX_TEST_DURATION_SECONDS"; then
    echo "❌ GEOROIDS_TEST_MAX_DURATION_SECONDS must be a positive integer" >&2
    exit 64
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
WATCHDOG_PID=""
PROXY_PID=""
BENCHMARK_SESSION=""
BENCHMARK_ARTIFACT_DIR=""
TEST_TIMED_OUT=false
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
        return 1
    fi

    if ! rm -f "$LOCK_PID_FILE" "$LOCK_WORKTREE_FILE" "$LOCK_COMMAND_FILE"; then
        echo "❌ Could not remove test-runner lock metadata: $LOCK_DIR" >&2
        return 1
    fi
    if ! rmdir "$LOCK_DIR" 2>/dev/null; then
        echo "❌ Could not remove test-runner lock directory: $LOCK_DIR" >&2
        return 1
    fi
    LOCK_HELD=false
}

stop_watchdog() {
    [ -n "$WATCHDOG_PID" ] || return 0
    if terminate_process_tree "$WATCHDOG_PID"; then
        WATCHDOG_PID=""
        return 0
    fi
    return 1
}

on_test_timeout() {
    TEST_TIMED_OUT=true
}

cleanup() {
    local exit_code=$?
    if [ "$CLEANUP_RUNNING" = true ]; then
        exit "$exit_code"
    fi
    CLEANUP_RUNNING=true
    trap - EXIT INT TERM ALRM

    if [ -n "$TEST_PID" ]; then
        if ! terminate_process_tree "$TEST_PID" && [ "$exit_code" -eq 0 ]; then
            exit_code=1
        fi
        TEST_PID=""
    fi
    if ! stop_watchdog && [ "$exit_code" -eq 0 ]; then
        exit_code=1
    fi
    if [ -n "$DEV_PID" ]; then
        if ! terminate_process_tree "$DEV_PID" && [ "$exit_code" -eq 0 ]; then
            exit_code=1
        fi
        DEV_PID=""
    fi
    if [ -n "$PROXY_PID" ]; then
        if ! terminate_process_tree "$PROXY_PID" && [ "$exit_code" -eq 0 ]; then exit_code=1; fi
    fi
    if [ -n "$BENCHMARK_SESSION" ]; then
        if [ -n "$BENCHMARK_ARTIFACT_DIR" ]; then
            if [ -f "$BENCHMARK_SESSION/proxy-stats.json" ]; then
                cp "$BENCHMARK_SESSION/proxy-stats.json" "$BENCHMARK_ARTIFACT_DIR/proxy-stats.json" || exit_code=1
            fi
            printf '{"exitCode":%s,"timedOut":%s}\n' "$exit_code" "$TEST_TIMED_OUT" > "$BENCHMARK_ARTIFACT_DIR/runner.json" || exit_code=1
        fi
        rm -rf -- "$BENCHMARK_SESSION" || exit_code=1
    fi
    if ! release_lock && [ "$exit_code" -eq 0 ]; then
        exit_code=1
    fi
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap on_test_timeout ALRM

servers_ready() {
    curl -sf --connect-timeout 1 --max-time 5 "http://localhost:$TEST_VITE_PORT/" > /dev/null 2>&1 && \
        curl -sf --connect-timeout 1 --max-time 5 "http://localhost:$TEST_SERVER_PORT/health" > /dev/null 2>&1
}

port_in_use() {
    local port="$1"
    local lsof_status
    if process_inspect lsof -nP -iTCP:"$port" -sTCP:LISTEN; then
        return 0
    else
        lsof_status=$?
    fi
    if [ "$lsof_status" -gt 1 ]; then
        report_process_inspection_failure "test port" lsof "$port"
    fi
    return "$lsof_status"
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

    local required_command
    for required_command in lsof pgrep ps; do
        if ! command -v "$required_command" > /dev/null 2>&1; then
            echo "❌ $required_command is required to verify test ports and owned processes" >&2
            return 1
        fi
    done

    local occupied_ports=()
    local port
    local port_status
    for port in "$TEST_VITE_PORT" "$TEST_SERVER_PORT"; do
        port_status=0
        port_in_use "$port" || port_status=$?
        case "$port_status" in
            0) occupied_ports+=("$port") ;;
            1) ;;
            *) return "$port_status" ;;
        esac
    done
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

    local benchmark_seed=42
    local benchmark_network=clean
    local previous=""
    local argument
    for argument in "${RUNNER_ARGS[@]}"; do
        case "$previous" in
            --seed) benchmark_seed="$argument" ;;
            --network) benchmark_network="$argument" ;;
        esac
        case "$argument" in
            --seed=*) benchmark_seed="${argument#*=}" ;;
            --network=*) benchmark_network="${argument#*=}" ;;
        esac
        previous="$argument"
    done
    local gameplay_port="$TEST_SERVER_PORT"
    if [ "$RUN_MODE" != tests ]; then
        valid_positive_integer "$benchmark_seed" || return 64
        case "$benchmark_network" in clean|normal|degraded) ;; *) return 64 ;; esac
        BENCHMARK_SESSION=$(mktemp -d "${TMPDIR:-/tmp}/geo-bench.XXXXXX") || return 1
        BENCHMARK_ARTIFACT_DIR="$REPO_ROOT/.performance/runner-${BENCHMARK_SESSION##*/}"
        mkdir -p "$BENCHMARK_ARTIFACT_DIR" || return 1
        export GEOROIDS_BENCHMARK_SESSION="$BENCHMARK_SESSION"
        export GEOROIDS_BENCHMARK_SEED="$benchmark_seed"
    fi
    if [ "$RUN_MODE" = benchmark-client ] && [ "$benchmark_network" != clean ]; then
        npx --no-install tsx scripts/benchmark-proxy.ts --target "$TEST_SERVER_PORT" \
            --network "$benchmark_network" --seed "$benchmark_seed" \
            --ready "$BENCHMARK_SESSION/proxy-port" --stats "$BENCHMARK_SESSION/proxy-stats.json" > "$BENCHMARK_ARTIFACT_DIR/proxy.log" 2>&1 &
        PROXY_PID=$!
        local attempts=0
        until [ -s "$BENCHMARK_SESSION/proxy-port" ]; do
            kill -0 "$PROXY_PID" 2>/dev/null || return 1
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 100 ]; then return 1; fi
            sleep 0.1
        done
        gameplay_port=$(cat "$BENCHMARK_SESSION/proxy-port")
        valid_port "$gameplay_port" || return 1
    fi
    export GEOROIDS_BENCHMARK_WS_URL="ws://localhost:$gameplay_port/ws"
    local client_command="vite --configLoader runner --port $TEST_VITE_PORT --strictPort"
    local server_entry=server.ts
    if [ "$RUN_MODE" != tests ]; then
        server_entry=benchmarks/realtime-server.ts
    fi
    if [ "$BUILD_MODE" = production ]; then
        echo "Building production client for the owned session..."
        VITE_WEBSOCKET_URL="ws://localhost:$gameplay_port/ws" npm run build || return 1
        client_command="vite preview --configLoader runner --host 127.0.0.1 --port $TEST_VITE_PORT --strictPort"
    fi
    echo "🚀 Starting servers owned by this runner..."
    (
        export NODE_ENV="$BUILD_MODE"
        export VITEST=false
        export PORT="$TEST_SERVER_PORT"
        if [ "$RUN_MODE" != tests ]; then
            export GEOROIDS_PERFORMANCE=1
        fi
        export VITE_WEBSOCKET_URL="ws://localhost:$TEST_SERVER_PORT/ws"
        exec npx --no-install concurrently \
            --kill-others \
            --prefix-colors "blue.bold,green.bold" \
            --prefix "[{name}]" \
            --names "vite,network" \
            "$client_command" \
            "tsx --env-file=.env.local $server_entry"
    ) &
    DEV_PID=$!

    if ! wait_for_servers; then
        echo "❌ Failed to start dev servers" >&2
        return 1
    fi
}

contains_browser_path() {
    local arg
    local path
    local path_filter_found=false

    # With no file filter Vitest discovers every test, including browser
    # scenarios, so use their longer hook timeout.
    if [ "$#" -eq 0 ]; then
        return 0
    fi

    for arg in "$@"; do
        case "$arg" in
            -*) continue ;;
        esac

        path="${arg%/}"
        path="${path#./}"
        case "$path" in
            ''|.|\
            "$REPO_ROOT"|"$REPO_ROOT/tests"|"$REPO_ROOT/tests/integration"|\
            tests|tests/integration|\
            "$REPO_ROOT/tests/integration/browser"|"$REPO_ROOT/tests/integration/browser/"*|\
            tests/integration/browser|tests/integration/browser/*)
                return 0
                ;;
        esac
        case "$path" in
            tests/*|"$REPO_ROOT"/*|*.test.ts|*.spec.ts) path_filter_found=true ;;
        esac
    done

    # Options such as --reporter do not narrow discovery. If there is no test
    # path at all, Vitest can still discover the browser suite.
    [ "$path_filter_found" = false ]
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

    if [ "$RUN_MODE" != tests ]; then
        case "$RUN_MODE" in
            benchmark-client) vitest_command=(npx --no-install tsx benchmarks/realtime-client.ts) ;;
            benchmark-load) vitest_command=(npx --no-install tsx benchmarks/load.ts) ;;
        esac
    fi
    echo "🧪 Running $RUN_MODE with repository-scoped single-instance protection..."
    printf '%s' "📝 Test arguments:"
    if [ "${#test_args[@]}" -gt 0 ]; then
        printf ' %q' "${test_args[@]}"
    fi
    printf '\n📝 Vitest config: %s\n' "$vitest_config"

    VITEST_MAX_WORKERS=1 "${vitest_command[@]}" "${test_args[@]}" &
    TEST_PID=$!
    TEST_TIMED_OUT=false
    (
        trap 'exit 0' INT TERM
        sleep "$MAX_TEST_DURATION_SECONDS" &
        watchdog_sleep_pid=$!
        wait "$watchdog_sleep_pid" || exit 0
        kill -ALRM "$$" 2>/dev/null || true
    ) &
    WATCHDOG_PID=$!

    wait "$TEST_PID"
    local exit_code=$?

    if ! stop_watchdog && [ "$exit_code" -eq 0 ]; then
        exit_code=1
    fi

    if [ "$TEST_TIMED_OUT" = true ]; then
        echo "❌ Tests exceeded ${MAX_TEST_DURATION_SECONDS}s; terminating the owned test process tree" >&2
        if terminate_process_tree "$TEST_PID"; then
            TEST_PID=""
        fi
        return 124
    fi

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

    local startup_status=0
    start_dev_servers || startup_status=$?
    if [ "$startup_status" -ne 0 ]; then
        exit "$startup_status"
    fi

    run_tests "${test_args[@]}"
    return $?
}

main "$@"
