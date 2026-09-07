#!/usr/bin/env bash

# Exercise the test runner's process-boundary safeguards without starting
# Vitest or the GeoRoids development servers.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/scripts/test-runner.sh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/georoids-test-runner-contract.XXXXXX")"
LISTENER_PID=""
GIT_COMMON_DIR="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$GIT_COMMON_DIR" in
    /*) ;;
    *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;;
esac
LOCK_DIR="$GIT_COMMON_DIR/georoids-test-runner.lock"

cleanup() {
    if [ -n "$LISTENER_PID" ] && kill -0 "$LISTENER_PID" 2>/dev/null; then
        kill "$LISTENER_PID" 2>/dev/null || true
        wait "$LISTENER_PID" 2>/dev/null || true
    fi
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
    echo "❌ $*" >&2
    exit 1
}

assert_lock_released() {
    [ ! -e "$LOCK_DIR" ] || fail "runner lock was not released: $LOCK_DIR"
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
assert_occupied_port_rejected

echo "✅ Test-runner contract checks passed"
