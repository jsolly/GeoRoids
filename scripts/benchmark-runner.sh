#!/usr/bin/env bash

# Manual benchmark sessions own their service pair and queue native workloads.
# The common-Git runner lock also preserves legacy ownership and authenticates
# coordinator children; each standalone pair selects unused ports.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }
set -uo pipefail
ORIGINAL_RUNNER_ARGS=("$@")
VALIDATION_CHILD=false
if [[ "${1:-}" == --validation-child ]]; then
    VALIDATION_CHILD=true
    shift
fi

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
# shellcheck source=scripts/test-runner-ports.sh
source "$REPO_ROOT/scripts/test-runner-ports.sh"

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
REQUESTED_VITE_PORT="${GEOROIDS_TEST_VITE_PORT:-}"
REQUESTED_SERVER_PORT="${GEOROIDS_TEST_SERVER_PORT:-}"
REQUESTED_PROXY_PORT="${GEOROIDS_TEST_PROXY_PORT:-}"
MAX_TEST_DURATION_SECONDS="${GEOROIDS_TEST_MAX_DURATION_SECONDS:-1200}"
RUN_MODE=""
REUSE_BENCHMARK_BUILD=false
BUILD_MODE=production
case "${1:-}" in
    --benchmark-client) RUN_MODE=benchmark-client; shift ;;
    --benchmark-load) RUN_MODE=benchmark-load; shift ;;
    *) echo "Select --benchmark-client or --benchmark-load" >&2; exit 64 ;;
esac
if [ "${1:-}" = --reuse-build ] && [ "$RUN_MODE" = benchmark-client ]; then
    REUSE_BENCHMARK_BUILD=true
    shift
fi
for argument in "$@"; do
    case "$argument" in
        --reuse-build|--reuse-build=*) echo "--reuse-build must follow --benchmark-client" >&2; exit 64 ;;
    esac
done
if ! valid_port "$TEST_VITE_PORT" || ! valid_port "$TEST_SERVER_PORT"; then
    echo "Benchmark service ports must be valid TCP ports" >&2; exit 64
fi
if ! valid_positive_integer "$MAX_TEST_DURATION_SECONDS"; then
    echo "Benchmark deadline must be a positive integer" >&2; exit 64
fi
RUNNER_ARGS=("$@")
if [ "$VALIDATION_CHILD" = true ]; then
    node "$REPO_ROOT/scripts/validation-admission.mjs" verify runner "$$" || exit 1
else
    exec node "$REPO_ROOT/scripts/validation-admission.mjs" runner -- "$BASH" "$REPO_ROOT/scripts/benchmark-runner.sh" --validation-child "${ORIGINAL_RUNNER_ARGS[@]}"
fi
# Publish defaults only inside the issued runner. The outer wrapper must preserve
# absent port selections so its child can allocate automatic ports.
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
RUNNER_RECEIPT="${GEOROIDS_TEST_RUNNER_RECEIPT:-}"
RUNNER_STARTED_AT="$(date +%s)"
TEST_TIMED_OUT=false
CLEANUP_RUNNING=false
CLEANUP_FAILED=false
INTERRUPT_SIGNAL=""
REGISTERING_CHILD=false
PENDING_INTERRUPT_CODE=""

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

write_lock_metadata() {
    if ! printf '%s\n' "$$" > "$LOCK_PID_FILE" || \
        ! printf '%s\n' "$REPO_ROOT" > "$LOCK_WORKTREE_FILE" || \
        ! printf '%s\n' "$*" > "$LOCK_COMMAND_FILE"; then
        echo "❌ Could not write test-runner lock metadata" >&2
        if lock_cleanup_pending; then return 1; fi
        rm -f "$LOCK_PID_FILE" "$LOCK_WORKTREE_FILE" "$LOCK_COMMAND_FILE"
        rmdir "$LOCK_DIR" 2>/dev/null || true
        return 1
    fi
    return 0
}

lock_cleanup_pending() {
    [ -e "$LOCK_DIR/ownership-pending.json" ] || [ -e "$LOCK_DIR/cleanup-failed.json" ]
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

    if lock_cleanup_pending; then
        echo "❌ Unresolved coordinated cleanup blocks this test-runner lock: $LOCK_DIR" >&2
        return 1
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
        if lock_cleanup_pending; then return 1; fi
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

    if lock_cleanup_pending; then
        echo "❌ Retaining test-runner lock until owned cleanup is resolved: $LOCK_DIR" >&2
        return 1
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

# Signal a process tree without waiting. `wait` inside this ALRM trap restarts as
# waitpid(-1) in bash 5.2 and then hangs on still-running owned servers.
signal_tree_nowait() {
    local root="${1:-}"
    local signal="${2:-KILL}"
    local child
    local children=""
    valid_pid "$root" || return 0
    children="$(pgrep -P "$root" 2>/dev/null || true)"
    for child in $children; do
        signal_tree_nowait "$child" "$signal"
    done
    kill "-$signal" "$root" 2>/dev/null || true
}

on_test_timeout() {
    TEST_TIMED_OUT=true
    signal_tree_nowait "${TEST_PID:-}" KILL
}

cleanup() {
    local exit_code=$?
    if [ "$CLEANUP_RUNNING" = true ]; then
        exit "$exit_code"
    fi
    CLEANUP_RUNNING=true
    local cleanup_succeeded=true
    if [ "$CLEANUP_FAILED" = true ]; then cleanup_succeeded=false; fi
    trap - EXIT
    trap '' INT TERM ALRM

    if [ -n "$TEST_PID" ]; then
        if ! terminate_process_tree "$TEST_PID"; then
            cleanup_succeeded=false
            if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
        fi
        TEST_PID=""
    fi
    if ! stop_watchdog; then
        cleanup_succeeded=false
        if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
    fi
    if [ -n "$DEV_PID" ]; then
        if ! terminate_process_tree "$DEV_PID"; then
            cleanup_succeeded=false
            if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
        fi
        DEV_PID=""
    fi
    if [ -n "$PROXY_PID" ]; then
        if ! terminate_process_tree "$PROXY_PID"; then
            cleanup_succeeded=false
            if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
        fi
        PROXY_PID=""
    fi
    if [ -n "$BENCHMARK_SESSION" ]; then
        if [ -n "$BENCHMARK_ARTIFACT_DIR" ]; then
            if [ -f "$BENCHMARK_SESSION/proxy-stats.json" ]; then
                if ! cp "$BENCHMARK_SESSION/proxy-stats.json" "$BENCHMARK_ARTIFACT_DIR/proxy-stats.json"; then
                    cleanup_succeeded=false
                    exit_code=1
                fi
            fi
        fi
        if ! rm -rf -- "$BENCHMARK_SESSION" || [ -e "$BENCHMARK_SESSION" ]; then
            cleanup_succeeded=false
            exit_code=1
        fi
    fi
    if [ "$cleanup_succeeded" != true ] && [ "$LOCK_HELD" = true ]; then
        # Retain the original common lock too, including for older entrypoints
        # that do not participate in validation admission.
        if ! printf '{"ownerPid":%s,"cleanupSucceeded":false}\n' "$$" > "$LOCK_DIR/cleanup-failed.json"; then
            echo "❌ Could not record unresolved runner cleanup" >&2
        fi
    fi
    if ! release_lock; then
        cleanup_succeeded=false
        if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
    fi
    if [ "$cleanup_succeeded" != true ] && [ "$exit_code" -eq 0 ]; then exit_code=1; fi
    # Final receipts follow owned process shutdown, diagnostic retention, session
    # removal and lock release. A failed write can never certify this runner.
    if [ -n "$BENCHMARK_ARTIFACT_DIR" ] || [ -n "$RUNNER_RECEIPT" ]; then
        if ! node "$REPO_ROOT/scripts/review-receipt.mjs" runner \
            "$BENCHMARK_ARTIFACT_DIR" "$RUNNER_RECEIPT" "$RUN_MODE" "$REPO_ROOT" \
            "$$" "$RUNNER_STARTED_AT" "$exit_code" "$cleanup_succeeded" \
            "$TEST_TIMED_OUT" "$LOCK_HELD" "$BENCHMARK_SESSION" "$INTERRUPT_SIGNAL"; then
            echo "❌ Could not retain final runner cleanup receipt" >&2
            exit_code=1
        fi
    fi
    exit "$exit_code"
}

trap cleanup EXIT
on_interrupt() {
    INTERRUPT_SIGNAL="$1"
    PENDING_INTERRUPT_CODE="$2"
    if [ "$REGISTERING_CHILD" = false ]; then exit "$PENDING_INTERRUPT_CODE"; fi
}

honor_pending_interrupt() {
    REGISTERING_CHILD=false
    if [ -n "$PENDING_INTERRUPT_CODE" ]; then exit "$PENDING_INTERRUPT_CODE"; fi
}

trap 'on_interrupt SIGINT 130' INT
trap 'on_interrupt SIGTERM 143' TERM
trap on_test_timeout ALRM

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
    local readiness_status
    while [ "$retries" -lt 20 ]; do
        kill -0 "$DEV_PID" 2>/dev/null || return 1
        readiness_status=0
        servers_ready || readiness_status=$?
        if [ "$readiness_status" -eq 0 ]; then
            echo "✅ Dev servers are running"
            return 0
        fi
        if [ "$readiness_status" -gt 1 ]; then return "$readiness_status"; fi
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
    local log_directory="${GEOROIDS_TEST_LOG_DIR:-logs}"
    mkdir -p "$log_directory" || return 1
    if ! rm -f "$log_directory/client.log" "$log_directory/server.log"; then
        echo "❌ Could not clear test logs before starting the runner" >&2
        return 1
    fi
    if ! touch "$log_directory/client.log" "$log_directory/server.log"; then
        echo "❌ Could not create fresh test logs before starting the runner" >&2
        return 1
    fi
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
        valid_positive_integer "$benchmark_seed" || return 64
        case "$benchmark_network" in clean|normal|degraded) ;; *) return 64 ;; esac
        BENCHMARK_SESSION=$(mktemp -d "${TMPDIR:-/tmp}/geo-bench.XXXXXX") || return 1
        BENCHMARK_ARTIFACT_DIR="$REPO_ROOT/.performance/runner-${BENCHMARK_SESSION##*/}"
        mkdir -p "$BENCHMARK_ARTIFACT_DIR" || return 1
        export GEOROIDS_BENCHMARK_SESSION="$BENCHMARK_SESSION"
        export GEOROIDS_BENCHMARK_SEED="$benchmark_seed"
    if [ "$RUN_MODE" = benchmark-client ]; then
        local proxy_port="${GEOROIDS_TEST_PROXY_PORT:-$((10#$TEST_SERVER_PORT + 1))}"
        if ! valid_port "$proxy_port" || [ "$proxy_port" -eq "$TEST_SERVER_PORT" ] || [ "$proxy_port" -eq "$TEST_VITE_PORT" ]; then
            echo "❌ GEOROIDS_TEST_PROXY_PORT must be a valid TCP port distinct from the owned server and Astro ports" >&2
            return 64
        fi
        REGISTERING_CHILD=true
        npx --no-install tsx scripts/benchmark-proxy.ts --target "$TEST_SERVER_PORT" --port "$proxy_port" \
            --network "$benchmark_network" --seed "$benchmark_seed" \
            --ready "$BENCHMARK_SESSION/proxy-port" --stats "$BENCHMARK_SESSION/proxy-stats.json" \
            --control "$BENCHMARK_SESSION/proxy.sock" > "$BENCHMARK_ARTIFACT_DIR/proxy.log" 2>&1 &
        PROXY_PID=$!
        honor_pending_interrupt
        local attempts=0
        until [ -s "$BENCHMARK_SESSION/proxy-port" ]; do
            kill -0 "$PROXY_PID" 2>/dev/null || return 1
            attempts=$((attempts + 1))
            if [ "$attempts" -ge 100 ]; then return 1; fi
            sleep 0.1
        done
        gameplay_port=$(cat "$BENCHMARK_SESSION/proxy-port")
        valid_port "$gameplay_port" || return 1
        [ "$gameplay_port" -eq "$proxy_port" ] || return 1
    fi
    export GEOROIDS_BENCHMARK_WS_URL="ws://localhost:$gameplay_port/ws"
    local client_command="astro dev --ignore-lock --port $TEST_VITE_PORT"
    local server_entry=benchmarks/realtime-server.ts
    local server_env=.env.local
    if [ "$BUILD_MODE" = production ]; then
        if [ "$REUSE_BENCHMARK_BUILD" = true ]; then
            echo "Verifying frozen production client for the owned benchmark session..."
            node scripts/benchmark-build-receipt.mjs verify "$REPO_ROOT" "$GEOROIDS_BENCHMARK_WS_URL" || return 1
        else
            if [ "$RUN_MODE" = benchmark-client ]; then
                node scripts/benchmark-build-receipt.mjs prepare "$REPO_ROOT" "$GEOROIDS_BENCHMARK_WS_URL" "$BENCHMARK_SESSION/build-inputs.json" || return 1
            fi
            echo "Building production client for the owned session..."
            VITE_WEBSOCKET_URL="ws://localhost:$gameplay_port/ws" npm run build || return 1
            if [ "$RUN_MODE" = benchmark-client ]; then
                node scripts/benchmark-build-receipt.mjs record "$REPO_ROOT" "$GEOROIDS_BENCHMARK_WS_URL" "$BENCHMARK_SESSION/build-inputs.json" || return 1
            fi
        fi
        client_command="astro preview --ignore-lock --host 127.0.0.1 --port $TEST_VITE_PORT"
    fi
    echo "🚀 Starting servers owned by this runner..."
    REGISTERING_CHILD=true
    (
        export NODE_ENV="$BUILD_MODE"
        export VITEST=""
        export PORT="$TEST_SERVER_PORT"
        export GEOROIDS_PERFORMANCE=1
        export VITE_WEBSOCKET_URL="ws://localhost:$TEST_SERVER_PORT/ws"
        GEOROIDS_WORLD_PATH=:memory: exec npx --no-install concurrently \
            --kill-others \
            --prefix-colors "blue.bold,green.bold" \
            --prefix "[{name}]" \
            --names "astro,network" \
            "$client_command" \
            "node --env-file=$server_env --import tsx $server_entry"
    ) &
    DEV_PID=$!
    honor_pending_interrupt

    if ! wait_for_servers; then
        echo "❌ Failed to start dev servers" >&2
        return 1
    fi
}

run_benchmark() {
    local -a test_args=("$@")
    local -a benchmark_command
    case "$RUN_MODE" in
        benchmark-client) benchmark_command=(npx --no-install tsx benchmarks/realtime-client.ts) ;;
        benchmark-load) benchmark_command=(npx --no-install tsx benchmarks/load.ts) ;;
    esac
    echo "Running owned manual $RUN_MODE..."
    REGISTERING_CHILD=true
    VITEST_MAX_WORKERS=1 "${benchmark_command[@]}" "${test_args[@]}" &
    TEST_PID=$!
    honor_pending_interrupt
    local test_wait_pid="$TEST_PID"
    TEST_TIMED_OUT=false
    REGISTERING_CHILD=true
    (
        watchdog_interrupted=false
        trap 'watchdog_interrupted=true' INT TERM
        sleep "$MAX_TEST_DURATION_SECONDS" &
        watchdog_sleep_pid=$!
        trap 'kill -TERM "$watchdog_sleep_pid" 2>/dev/null || true; wait "$watchdog_sleep_pid" 2>/dev/null || true; exit 0' INT TERM
        if [ "$watchdog_interrupted" = true ]; then
            kill -TERM "$watchdog_sleep_pid" 2>/dev/null || true
            wait "$watchdog_sleep_pid" 2>/dev/null || true
            exit 0
        fi
        wait "$watchdog_sleep_pid" || exit 0
        kill -ALRM "$$" 2>/dev/null || true
    ) &
    WATCHDOG_PID=$!
    honor_pending_interrupt

    local exit_code=0
    while kill -0 "$test_wait_pid" 2>/dev/null; do
        if [ "$TEST_TIMED_OUT" = true ]; then
            break
        fi
        sleep 0.05 || true
    done

    if [ "$TEST_TIMED_OUT" = true ]; then
        exit_code=124
    else
        wait "$test_wait_pid"
        exit_code=$?
    fi
    wait "$test_wait_pid" 2>/dev/null || true

    # The deadline covers test execution. Watchdog cleanup can itself take time;
    # a late alarm must not turn a completed test into a timeout.
    trap '' ALRM
    if ! stop_watchdog; then
        CLEANUP_FAILED=true
        if [ "$exit_code" -eq 0 ]; then exit_code=1; fi
    fi

    if [ "$TEST_TIMED_OUT" = true ]; then
        echo "❌ Tests exceeded ${MAX_TEST_DURATION_SECONDS}s; terminating the owned test process tree" >&2
        if [ -n "${TEST_PID:-}" ]; then
            if terminate_process_tree "$TEST_PID"; then
                TEST_PID=""
            fi
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
    acquire_lock "$@" || return 1
    select_test_ports || return $?
    start_dev_servers || return $?
    run_benchmark "$@"
}
main "$@"
