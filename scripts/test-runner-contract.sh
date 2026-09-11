#!/usr/bin/env bash

# Exercise the test runner's process-boundary safeguards without starting
# Vitest or the GeoRoids development servers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/scripts/test-runner.sh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/georoids-test-runner-contract.XXXXXX")"
LISTENER_PID=""
MOCK_BIN="$TEMP_DIR/mock-bin"
MOCK_DEV_PID_FILE="$TEMP_DIR/mock-dev.pid"
MOCK_TEST_PID_FILE="$TEMP_DIR/mock-test.pid"
MOCK_DEV_CHILD_PID_FILE="$TEMP_DIR/mock-dev-child.pid"
MOCK_TEST_CHILD_PID_FILE="$TEMP_DIR/mock-test-child.pid"
MOCK_FAILURE_MARKER_FILE="$TEMP_DIR/process-tree-failure-seen"
REAL_RMDIR="$(command -v rmdir)"
REAL_PGREP="$(command -v pgrep)"

cleanup() {
    local pid_file
    local pid
    if [ -n "$LISTENER_PID" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
        kill "$LISTENER_PID" 2>/dev/null || true
        wait "$LISTENER_PID" 2>/dev/null || true
    fi
    for pid_file in \
        "$MOCK_DEV_PID_FILE.proxy" \
        "$MOCK_TEST_CHILD_PID_FILE" \
        "$MOCK_TEST_PID_FILE" \
        "$MOCK_DEV_CHILD_PID_FILE" \
        "$MOCK_DEV_PID_FILE"; do
        if [ -f "$pid_file" ]; then
            IFS= read -r pid < "$pid_file" || true
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
    done
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Exercise the real runner in an owned repository. Contract checks must never
# acquire, remove, or assert on another checkout's integration-runner lock.
CONTRACT_ROOT="$TEMP_DIR/repository"
GIT_LOCAL_ENV_VARS="$(git -C "$ROOT" rev-parse --local-env-vars)"
while IFS= read -r git_variable; do
    unset "$git_variable"
done <<< "$GIT_LOCAL_ENV_VARS"
mkdir -p "$CONTRACT_ROOT/scripts"
cp "$ROOT/scripts/process-tree.sh" "$CONTRACT_ROOT/scripts/process-tree.sh"
cp "$ROOT/.env.example" "$CONTRACT_ROOT/.env.example"
git -C "$CONTRACT_ROOT" init -q
cd "$CONTRACT_ROOT"
CONTRACT_ROOT="$(git rev-parse --show-toplevel)"
CONTRACT_GIT_DIR="$(git rev-parse --git-common-dir)"
case "$CONTRACT_GIT_DIR" in
    /*) ;;
    *) CONTRACT_GIT_DIR="$CONTRACT_ROOT/$CONTRACT_GIT_DIR" ;;
esac
LOCK_DIR="$CONTRACT_GIT_DIR/georoids-test-runner.lock"

fail() {
    echo "❌ $*" >&2
    exit 1
}

assert_lock_released() {
    [ ! -e "$LOCK_DIR" ] || fail "runner lock was not released: $LOCK_DIR"
}

assert_pid_stopped() {
    local pid_file="$1"
    local label="$2"
    local pid=""
    local attempt
    [ -s "$pid_file" ] || fail "$label did not record its PID"
    IFS= read -r pid < "$pid_file" || true
    for ((attempt = 0; attempt < 10; attempt++)); do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.05
    done
    fail "$label process $pid survived runner cleanup"
}

assert_rejected() {
    local name="$1"
    shift
    local output_file="$TEMP_DIR/$name.txt"
    local exit_code

    if GEOROIDS_TEST_VITE_PORT=59991 GEOROIDS_TEST_SERVER_PORT=59992 \
        "$RUNNER" "$@" > "$output_file" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi

    [ "$exit_code" -eq 64 ] || {
        cat "$output_file" >&2
        fail "$name was not rejected with usage error (exit $exit_code)"
    }
    grep -Fq "serialized settings cannot be overridden" "$output_file" || {
        cat "$output_file" >&2
        fail "$name did not explain the protected runner contract"
    }
    if grep -Fq "Checking that test ports" "$output_file"; then
        cat "$output_file" >&2
        fail "$name reached server startup instead of being rejected"
    fi
    assert_lock_released
}

find_free_port() {
    local candidate
    for ((candidate = 52000; candidate < 53000; candidate++)); do
        if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN > /dev/null 2>&1; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

assert_occupied_port_rejected() {
    local occupied_port
    local server_port
    local output_file="$TEMP_DIR/occupied-port.txt"
    local exit_code

    command -v lsof > /dev/null 2>&1 || fail "lsof is required for the occupied-port contract check"
    command -v node > /dev/null 2>&1 || fail "node is required for the occupied-port contract check"

    occupied_port="$(find_free_port)" || fail "could not find a free port for the occupied-port check"
    server_port=$((occupied_port + 1))
    while lsof -nP -iTCP:"$server_port" -sTCP:LISTEN > /dev/null 2>&1; do
        server_port=$((server_port + 1))
    done

    node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' \
        "$occupied_port" &
    LISTENER_PID=$!

    for _ in {1..20}; do
        if lsof -nP -iTCP:"$occupied_port" -sTCP:LISTEN > /dev/null 2>&1; then
            break
        fi
        sleep 0.05
    done
    lsof -nP -iTCP:"$occupied_port" -sTCP:LISTEN > /dev/null 2>&1 || \
        fail "the occupied-port listener did not start"

    if GEOROIDS_TEST_VITE_PORT="$occupied_port" GEOROIDS_TEST_SERVER_PORT="$server_port" \
        "$RUNNER" tests/integration/server/ > "$output_file" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi

    [ "$exit_code" -eq 1 ] || {
        cat "$output_file" >&2
        fail "occupied test port was not refused (exit $exit_code)"
    }
    grep -Fq "already in use" "$output_file" || {
        cat "$output_file" >&2
        fail "occupied test port error did not identify the conflict"
    }
    grep -Fq "GEOROIDS_TEST_VITE_PORT=<port>" "$output_file" || {
        cat "$output_file" >&2
        fail "occupied test port error did not provide the custom-port remedy"
    }
    assert_lock_released

    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
    LISTENER_PID=""
}

setup_mock_tools() {
    mkdir -p "$MOCK_BIN"

    cat > "$MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
# Contract processes never bind ports; report them free.
    if [ "${GEOROIDS_CONTRACT_MODE:-}" = port-inspection-status-one ]; then
        echo "simulated lsof inspection failure (status 1)" >&2
        exit 1
    fi
    if [ "${GEOROIDS_CONTRACT_MODE:-}" = port-inspection-failure ]; then
        echo "simulated lsof inspection failure (status 2)" >&2
        exit 2
    fi
exit 1
EOF

    cat > "$MOCK_BIN/curl" <<'EOF'
#!/usr/bin/env bash
# Do not report readiness until the mock concurrently process has started.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$GEOROIDS_CONTRACT_DEV_PID_FILE" ] && exit 0
    sleep 0.02
done
exit 1
EOF

    cat > "$MOCK_BIN/npx" <<'EOF'
#!/usr/bin/env bash
case " $* " in
    *" tsx scripts/benchmark-proxy.ts "*)
        printf '%s\n' "$$" > "$GEOROIDS_CONTRACT_DEV_PID_FILE.proxy"
        printf '%s\n' "$GEOROIDS_BENCHMARK_SESSION" > "$GEOROIDS_CONTRACT_DEV_PID_FILE.session"
        while [ "$#" -gt 0 ]; do
            if [ "$1" = --ready ]; then shift; printf '59995' > "$1"; fi
            shift
        done
        trap 'exit 0' TERM INT
        while :; do sleep 30 & wait $! || true; done
        ;;
    *" concurrently "*)
        printf '%s\n' "$$" > "$GEOROIDS_CONTRACT_DEV_PID_FILE"
        trap '' TERM
        while :; do
            sleep 30 &
            printf '%s\n' "$!" > "$GEOROIDS_CONTRACT_DEV_CHILD_PID_FILE"
            wait $! || true
        done
        ;;
    *" vitest run "*|*" tsx benchmarks/realtime-client.ts "*|*" tsx benchmarks/load.ts "*)
        printf '%s\n' "$*" > "$GEOROIDS_CONTRACT_TEST_PID_FILE.command"
        printf '%s\n' "$$" > "$GEOROIDS_CONTRACT_TEST_PID_FILE"
        if [ "$GEOROIDS_CONTRACT_MODE" = timeout ]; then
            trap '' TERM
            while :; do
                sleep 30 &
                printf '%s\n' "$!" > "$GEOROIDS_CONTRACT_TEST_CHILD_PID_FILE"
                wait $! || true
            done
        fi
        if [ "$GEOROIDS_CONTRACT_MODE" = cleanup-failure-nonzero ]; then
            exit 7
        fi
        exit 0
        ;;
    *)
echo "unexpected mock package-runner invocation: $*" >&2
        exit 70
        ;;
esac
EOF

    cat > "$MOCK_BIN/npm" <<'EOF'
#!/usr/bin/env bash
[ "$*" = "run build" ] || exit 70
printf '%s\n' "$VITE_WEBSOCKET_URL" > "$GEOROIDS_CONTRACT_DEV_PID_FILE.build"
if [ "$GEOROIDS_CONTRACT_MODE" = build-failure ]; then exit 19; fi
EOF

    cat > "$MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-ps-status-one ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
    : > "$GEOROIDS_CONTRACT_FAILURE_MARKER"
    echo "simulated ps inspection failure (status 1)" >&2
    exit 1
fi
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-ps-failure ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
    : > "$GEOROIDS_CONTRACT_FAILURE_MARKER"
    exit 2
fi
pid=""
previous=""
for arg in "$@"; do
    if [ "$previous" = -p ]; then
        pid="$arg"
        break
    fi
    previous="$arg"
done

sticky_pid=""
if [ -s "$GEOROIDS_CONTRACT_DEV_PID_FILE" ]; then
    IFS= read -r sticky_pid < "$GEOROIDS_CONTRACT_DEV_PID_FILE" || true
fi
case "$GEOROIDS_CONTRACT_MODE" in
    cleanup-failure|cleanup-failure-nonzero) simulate_sticky_process=true ;;
    *) simulate_sticky_process=false ;;
esac
if [ "$simulate_sticky_process" = true ] && [ -n "$pid" ] && [ "$pid" = "$sticky_pid" ]; then
    case " $* " in
        *" lstart="*) printf '%s\n' 'Mon Jan  1 00:00:00 2024' ;;
        *" stat="*) printf '%s\n' 'S' ;;
        *) exit 1 ;;
    esac
    exit 0
fi
exec /bin/ps "$@"
EOF

    cat > "$MOCK_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-pgrep-failure ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
    : > "$GEOROIDS_CONTRACT_FAILURE_MARKER"
    exit 2
fi
exec "$GEOROIDS_CONTRACT_REAL_PGREP" "$@"
EOF

    cat > "$MOCK_BIN/rmdir" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "$GEOROIDS_CONTRACT_LOCK_DIR" ] && [ "$GEOROIDS_CONTRACT_MODE" = lock-release-failure ]; then
    exit 1
fi
exec "$GEOROIDS_CONTRACT_REAL_RMDIR" "$@"
EOF

    chmod +x "$MOCK_BIN/lsof" "$MOCK_BIN/curl" "$MOCK_BIN/npx" "$MOCK_BIN/ps" "$MOCK_BIN/pgrep" "$MOCK_BIN/rmdir" "$MOCK_BIN/npm"
}

run_mock_runner() {
    local mode="$1"
    local max_duration="$2"
    local output_file="$3"
    shift 3
    rm -f \
        "$MOCK_DEV_PID_FILE" \
        "$MOCK_TEST_PID_FILE" \
        "$MOCK_DEV_CHILD_PID_FILE" \
        "$MOCK_TEST_CHILD_PID_FILE" \
        "$MOCK_FAILURE_MARKER_FILE" "$MOCK_DEV_PID_FILE.proxy" "$MOCK_DEV_PID_FILE.session"
    env \
        PATH="$MOCK_BIN:$PATH" \
        GEOROIDS_CONTRACT_MODE="$mode" \
        GEOROIDS_CONTRACT_DEV_PID_FILE="$MOCK_DEV_PID_FILE" \
        GEOROIDS_CONTRACT_TEST_PID_FILE="$MOCK_TEST_PID_FILE" \
        GEOROIDS_CONTRACT_DEV_CHILD_PID_FILE="$MOCK_DEV_CHILD_PID_FILE" \
        GEOROIDS_CONTRACT_TEST_CHILD_PID_FILE="$MOCK_TEST_CHILD_PID_FILE" \
        GEOROIDS_CONTRACT_LOCK_DIR="$LOCK_DIR" \
        GEOROIDS_CONTRACT_REAL_RMDIR="$REAL_RMDIR" \
        GEOROIDS_CONTRACT_REAL_PGREP="$REAL_PGREP" \
        GEOROIDS_CONTRACT_FAILURE_MARKER="$MOCK_FAILURE_MARKER_FILE" \
        GEOROIDS_TEST_MAX_DURATION_SECONDS="$max_duration" \
        GEOROIDS_TEST_VITE_PORT=59993 \
        GEOROIDS_TEST_SERVER_PORT=59994 \
        "$RUNNER" "$@" > "$output_file" 2>&1
}

assert_vitest_config() {
    local name="$1"
    local expected_config="$2"
    shift 2
    local output_file="$TEMP_DIR/config-$name.txt"

    if ! run_mock_runner success 10 "$output_file" "$@"; then
        cat "$output_file" >&2
        fail "$name config-selection run failed"
    fi
    grep -Fq "Vitest config: $expected_config" "$output_file" || {
        cat "$output_file" >&2
        fail "$name did not select $expected_config"
    }
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "$name mock test"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "$name dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "$name dev-server child"
    assert_lock_released
}

assert_invalid_duration_rejected() {
    local output_file="$TEMP_DIR/invalid-duration.txt"
    local exit_code
    if GEOROIDS_TEST_MAX_DURATION_SECONDS=0 "$RUNNER" tests/integration/server/ > "$output_file" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 64 ] || {
        cat "$output_file" >&2
        fail "invalid maximum duration was not rejected with usage error (exit $exit_code)"
    }
    grep -Fq "must be a positive integer" "$output_file" || {
        cat "$output_file" >&2
        fail "invalid maximum duration did not explain the contract"
    }
    assert_lock_released
}

assert_test_timeout_cleans_owned_processes() {
    local output_file="$TEMP_DIR/timeout.txt"
    local exit_code
    if run_mock_runner timeout 1 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 124 ] || {
        cat "$output_file" >&2
        fail "hung test process did not return timeout exit 124 (exit $exit_code)"
    }
    grep -Fq "Tests exceeded 1s" "$output_file" || {
        cat "$output_file" >&2
        fail "timeout did not report its configured deadline"
    }
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "timed-out test"
    assert_pid_stopped "$MOCK_TEST_CHILD_PID_FILE" "timed-out test child"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "timeout dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "timeout dev-server child"
    assert_lock_released
}

assert_cleanup_failure_is_not_success() {
    local output_file="$TEMP_DIR/cleanup-failure.txt"
    local exit_code
    if run_mock_runner cleanup-failure 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 1 ] || {
        cat "$output_file" >&2
        fail "failed cleanup did not override a successful test exit (exit $exit_code)"
    }
    grep -Fq "Owned process tree rooted at PID" "$output_file" || {
        cat "$output_file" >&2
        fail "failed cleanup did not identify the owned process tree"
    }
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "successful mock test"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "cleanup-failure dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "cleanup-failure dev-server child"
    assert_lock_released
}

assert_cleanup_failure_preserves_test_failure() {
    local output_file="$TEMP_DIR/cleanup-failure-nonzero.txt"
    local exit_code
    if run_mock_runner cleanup-failure-nonzero 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 7 ] || {
        cat "$output_file" >&2
        fail "failed cleanup replaced the mock test's exit 7 (exit $exit_code)"
    }
    grep -Fq "Owned process tree rooted at PID" "$output_file" || {
        cat "$output_file" >&2
        fail "cleanup failure after a failed test was not reported"
    }
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "failed mock test"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "nonzero cleanup-failure dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "nonzero cleanup-failure dev-server child"
    assert_lock_released
}

assert_impaired_benchmark_cleanup() {
    local mode="$1"
    local expected="$2"
    local output_file="$TEMP_DIR/proxy-$mode.txt"
    local status=0
    local session
    run_mock_runner "$mode" 1 "$output_file" --benchmark-client --network degraded --seconds 1 || status=$?
    [ "$status" -eq "$expected" ] || { cat "$output_file" >&2; fail "proxy $mode exit $status, expected $expected"; }
    grep -Fxq 'ws://localhost:59995/ws' "$MOCK_DEV_PID_FILE.build" || fail 'client build bypassed ready proxy'
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "proxy $mode"
    IFS= read -r session < "$MOCK_DEV_PID_FILE.session"
    [ ! -e "$session" ] || fail "proxy $mode leaked private session directory"
    assert_lock_released
}

assert_live_benchmark_mode() {
    local mode="$1"
    local entry="$2"
    local output_file="$TEMP_DIR/$mode.txt"
    if ! run_mock_runner success 10 "$output_file" "--$mode" --seconds 1; then
        cat "$output_file" >&2
        fail "$mode failed"
    fi
    grep -Fxq -- "--no-install tsx benchmarks/$entry.ts --seconds 1" "$MOCK_TEST_PID_FILE.command" || fail "$mode selected wrong entry point"
    grep -Fxq 'ws://localhost:59994/ws' "$MOCK_DEV_PID_FILE.build" || fail "$mode did not build for its owned server"
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "$mode driver"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "$mode server"
    assert_lock_released
}

assert_invalid_build_rejected() {
    local exit_code
    if GEOROIDS_TEST_BUILD=invalid "$RUNNER" > "$TEMP_DIR/invalid-build.txt" 2>&1; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 64 ] || fail "invalid build mode was not rejected"
    assert_lock_released
}

assert_port_inspection_failure_is_not_success() {
    local mode="$1"
    local expected_exit="$2"
    local expected_cause="$3"
    local output_file="$TEMP_DIR/port-inspection-failure.txt"
    local exit_code
    if run_mock_runner "$mode" 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq "$expected_exit" ] || {
        cat "$output_file" >&2
        fail "$mode did not preserve its error exit (exit $exit_code)"
    }
    grep -Fq "Could not inspect test port" "$output_file" || {
        cat "$output_file" >&2
        fail "$mode did not identify the refusal"
    }
    grep -Fq "$expected_cause" "$output_file" || {
        cat "$output_file" >&2
        fail "$mode did not preserve the actionable lsof cause"
    }
    [ ! -e "$MOCK_DEV_PID_FILE" ] || fail "failed port inspection started a dev server"
    [ ! -e "$MOCK_TEST_PID_FILE" ] || fail "failed port inspection started Vitest"
    assert_lock_released
}

assert_lock_release_failure_is_not_success() {
    local output_file="$TEMP_DIR/lock-release-failure.txt"
    local exit_code
    if run_mock_runner lock-release-failure 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 1 ] || {
        cat "$output_file" >&2
        fail "failed lock cleanup did not override a successful test exit (exit $exit_code)"
    }
    grep -Fq "Could not remove test-runner lock directory" "$output_file" || {
        cat "$output_file" >&2
        fail "failed lock cleanup did not identify the lock directory"
    }
    [ -d "$LOCK_DIR" ] || fail "lock-release fixture did not preserve the failed lock directory"
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "lock-release-failure mock test"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "lock-release-failure dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "lock-release-failure dev-server child"
    "$REAL_RMDIR" "$LOCK_DIR"
    assert_lock_released
}

assert_process_inspection_failure_is_not_success() {
    local mode="$1"
    local expected_message="$2"
    local expected_cause="${3:-}"
    local output_file="$TEMP_DIR/$mode.txt"
    local exit_code
    if run_mock_runner "$mode" 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 1 ] || {
        cat "$output_file" >&2
        fail "$mode was reported as successful after process inspection failed (exit $exit_code)"
    }
    grep -Fq "$expected_message" "$output_file" || {
        cat "$output_file" >&2
        fail "$mode did not explain the process inspection failure"
    }
    if [ -n "$expected_cause" ]; then
        grep -Fq "$expected_cause" "$output_file" || {
            cat "$output_file" >&2
            fail "$mode did not preserve the actionable process inspection cause"
        }
    fi
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "$mode mock test"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "$mode dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "$mode dev-server child"
    assert_lock_released
}

assert_rejected "config-equals" --config=alternate.config.ts
assert_rejected "config-short" -c alternate.config.ts
assert_rejected "config-short-attached" -c=alternate.config.ts
assert_rejected "pool" --pool=threads
assert_rejected "pool-options" --poolOptions.forks.singleFork=true
assert_rejected "max-workers" --maxWorkers=2
assert_rejected "max-concurrency" --maxConcurrency=2
assert_rejected "no-isolate" --no-isolate
assert_rejected "file-parallelism" --fileParallelism=true
assert_rejected "no-file-parallelism" --no-file-parallelism
assert_rejected "sequence" --sequence.concurrent=true
assert_rejected "sequence-shuffle" --sequence.shuffle=true
assert_invalid_duration_rejected
assert_invalid_build_rejected
assert_occupied_port_rejected
setup_mock_tools
assert_port_inspection_failure_is_not_success \
    port-inspection-failure 2 "simulated lsof inspection failure (status 2)"
assert_port_inspection_failure_is_not_success \
    port-inspection-status-one 2 "simulated lsof inspection failure (status 1)"
assert_vitest_config "default-discovery" vitest.browser.config.ts
assert_vitest_config "default-with-options" vitest.browser.config.ts --reporter=verbose
assert_vitest_config "integration-parent" vitest.browser.config.ts tests/integration/
assert_vitest_config "tests-parent" vitest.browser.config.ts tests/
assert_vitest_config "browser-file" vitest.browser.config.ts \
    tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts
assert_vitest_config "server-only" vitest.config.ts tests/integration/server/
assert_vitest_config "entities-only" vitest.config.ts tests/integration/entities/
assert_vitest_config "server-and-entities" vitest.config.ts \
    tests/integration/server/ tests/integration/entities/
assert_impaired_benchmark_cleanup success 0
assert_impaired_benchmark_cleanup build-failure 1
assert_impaired_benchmark_cleanup timeout 124
assert_live_benchmark_mode benchmark-client realtime-client
assert_live_benchmark_mode benchmark-load load
assert_test_timeout_cleans_owned_processes
assert_cleanup_failure_is_not_success
assert_cleanup_failure_preserves_test_failure
assert_lock_release_failure_is_not_success
assert_process_inspection_failure_is_not_success \
    process-tree-pgrep-failure "Could not enumerate children of owned process PID"
assert_process_inspection_failure_is_not_success \
    process-tree-ps-failure "Could not inspect process start time for PID"
assert_process_inspection_failure_is_not_success \
    process-tree-ps-status-one "Could not inspect process start time for PID" \
    "simulated ps inspection failure (status 1)"

echo "✅ Test-runner contract checks passed"
