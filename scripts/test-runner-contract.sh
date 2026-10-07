#!/usr/bin/env bash

# Exercise the test runner's process-boundary safeguards without starting
# Vitest or the GeoRoids development servers.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/process-tree.sh
source "$ROOT/scripts/process-tree.sh"
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
REAL_RM="$(command -v rm)"
REAL_TOUCH="$(command -v touch)"
REAL_MKDIR="$(command -v mkdir)"

cleanup() {
    local status=$?
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
    if ((status == 0)); then
        rm -rf "$TEMP_DIR"
    else
        echo "Test-runner contract diagnostics retained at $TEMP_DIR" >&2
    fi
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Exercise the real runner in an owned repository. Contract checks must never
# acquire, remove, or assert on another checkout's integration-runner lock.
CONTRACT_ROOT="$TEMP_DIR/repository"
for git_variable in "${!GIT_@}"; do
    unset "$git_variable"
done
unset GEOROIDS_VALIDATION_CHECKOUT GEOROIDS_VALIDATION_ADMISSION GEOROIDS_VALIDATION_CHILD
export HOME="$TEMP_DIR/home"
export XDG_CONFIG_HOME="$TEMP_DIR/xdg"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME" "$XDG_CONFIG_HOME"
mkdir -p "$CONTRACT_ROOT/scripts"
mkdir -p "$CONTRACT_ROOT/tests/integration/browser/sanity" "$CONTRACT_ROOT/tests/integration/server"
printf '// explicit browser selector fixture\n' > "$CONTRACT_ROOT/tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts"
printf '// explicit server selector fixture\n' > "$CONTRACT_ROOT/tests/integration/server/selected-pilot.test.ts"
cp "$ROOT/scripts/test-runner.sh" "$CONTRACT_ROOT/scripts/test-runner.sh"
cp "$ROOT/scripts/process-tree.sh" "$CONTRACT_ROOT/scripts/process-tree.sh"
cp "$ROOT/scripts/review-receipt.mjs" "$CONTRACT_ROOT/scripts/review-receipt.mjs"
cp "$ROOT/scripts/integration-shard-plan.mjs" "$CONTRACT_ROOT/scripts/integration-shard-plan.mjs"
cp "$ROOT/scripts/benchmark-build-receipt.mjs" "$CONTRACT_ROOT/scripts/benchmark-build-receipt.mjs"
cp "$ROOT/scripts/test-ports.mjs" "$CONTRACT_ROOT/scripts/test-ports.mjs"
cp "$ROOT/scripts/test-runner-ports.sh" "$CONTRACT_ROOT/scripts/test-runner-ports.sh"
cp "$ROOT/scripts/validation-admission.mjs" "$CONTRACT_ROOT/scripts/validation-admission.mjs"
cp "$ROOT/.env.example" "$CONTRACT_ROOT/.env.example"
printf '{"lockfileVersion":3}\n' > "$CONTRACT_ROOT/package-lock.json"
git -C "$CONTRACT_ROOT" init -q
cd "$CONTRACT_ROOT"
CONTRACT_ROOT="$(git rev-parse --show-toplevel)"
CONTRACT_GIT_DIR="$(git rev-parse --git-common-dir)"
case "$CONTRACT_GIT_DIR" in
    /*) ;;
    *) CONTRACT_GIT_DIR="$CONTRACT_ROOT/$CONTRACT_GIT_DIR" ;;
esac
CONTRACT_GIT_DIR="$(cd "$CONTRACT_GIT_DIR" && pwd -P)"
EXPECTED_GIT_DIR="$(cd "$TEMP_DIR/repository/.git" && pwd -P)"
[ "$CONTRACT_GIT_DIR" = "$EXPECTED_GIT_DIR" ] || { echo "Fixture escaped private Git common directory" >&2; exit 1; }
if [[ "${1:-}" == --isolation-probe ]]; then
    printf 'private fixture\n' > isolation.txt
    git add isolation.txt
    exit 0
fi
git -c core.hooksPath=/dev/null -c user.name=Contract -c user.email=contract@example.invalid commit --allow-empty -qm 'fixture build identity'

# A hostile parent repository must survive the actual private-fixture entry.
HOSTILE_PARENT="$TEMP_DIR/hostile-parent"
mkdir -p "$HOSTILE_PARENT"
git -C "$HOSTILE_PARENT" init -q
printf 'parent\n' > "$HOSTILE_PARENT/parent.txt"
git -C "$HOSTILE_PARENT" add parent.txt
git -C "$HOSTILE_PARENT" -c core.hooksPath=/dev/null -c user.name=Contract -c user.email=contract@example.invalid commit -qm 'fixture parent'
printf 'staged parent\n' > "$HOSTILE_PARENT/parent.txt"
git -C "$HOSTILE_PARENT" add parent.txt
for parent_file in HEAD config index; do
    cp "$HOSTILE_PARENT/.git/$parent_file" "$TEMP_DIR/parent-$parent_file.before"
done
mkdir -p "$TEMP_DIR/hostile-home"
printf '[core]\n hooksPath = /untrusted\n' > "$TEMP_DIR/hostile-home/.gitconfig"
env GIT_DIR="$HOSTILE_PARENT/.git" GIT_WORK_TREE="$HOSTILE_PARENT" \
    GIT_INDEX_FILE="$HOSTILE_PARENT/.git/index" \
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.repositoryformatversion GIT_CONFIG_VALUE_0=999 \
    GIT_CONFIG_GLOBAL="$TEMP_DIR/hostile-home/.gitconfig" GIT_CONFIG_SYSTEM="$TEMP_DIR/hostile-home/.gitconfig" \
    HOME="$TEMP_DIR/hostile-home" XDG_CONFIG_HOME="$TEMP_DIR/hostile-home" \
    bash "$ROOT/scripts/test-runner-contract.sh" --isolation-probe
for parent_file in HEAD config index; do
    cmp "$HOSTILE_PARENT/.git/$parent_file" "$TEMP_DIR/parent-$parent_file.before" || { echo "Fixture mutated parent $parent_file" >&2; exit 1; }
done
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
    local state
    [ -s "$pid_file" ] || fail "$label did not record its PID"
    IFS= read -r pid < "$pid_file" || true
    for ((attempt = 0; attempt < 10; attempt++)); do
        state="$(process_state "$pid")" || fail "$label process $pid could not be inspected"
        case "$state" in
            Z*|'') return 0 ;;
        esac
        sleep 0.05
    done
    fail "$label process $pid survived runner cleanup"
}

assert_cleanup_state_contract() {
    local state_bin="$TEMP_DIR/state-bin"
    local pid_file="$TEMP_DIR/state-fixture.pid"
    local output_file="$TEMP_DIR/state-fixture.txt"
    local mode
    local expected
    local status
    mkdir -p "$state_bin"
    printf '900000000\n' > "$pid_file"
    cat > "$state_bin/ps" <<'EOF'
#!/usr/bin/env bash
case "$GEOROIDS_CONTRACT_STATE" in
    live) printf 'S\n' ;;
    zombie) printf 'Z\n' ;;
    absent) exit 1 ;;
    error) echo 'inspection failed' >&2; exit 2 ;;
    diagnostic) echo 'inspection failed' >&2; exit 1 ;;
    *) exit 70 ;;
esac
EOF
    chmod +x "$state_bin/ps"
    for mode in live zombie absent error diagnostic; do
        expected=1
        case "$mode" in zombie|absent) expected=0 ;; esac
        status=0
        (
            export PATH="$state_bin:$PATH" GEOROIDS_CONTRACT_STATE="$mode"
            assert_pid_stopped "$pid_file" "$mode fixture"
        ) > "$output_file" 2>&1 || status=$?
        [ "$status" -eq "$expected" ] || { cat "$output_file" >&2; fail "$mode cleanup state exit $status, expected $expected"; }
        if [ "$mode" = live ]; then
            grep -Fq 'survived runner cleanup' "$output_file" || fail 'live process lost rejection reason'
        elif [ "$expected" -eq 1 ]; then
            grep -Fq 'could not be inspected' "$output_file" || fail 'inspection failure was accepted as cleanup'
        fi
    done
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

assert_occupied_port_rejected() {
    local occupied_port
    local server_port
    local output_file="$TEMP_DIR/occupied-port.txt"
    local exit_code

    command -v lsof > /dev/null 2>&1 || fail "lsof is required for the occupied-port contract check"
    command -v node > /dev/null 2>&1 || fail "node is required for the occupied-port contract check"

    local ready_file="$TEMP_DIR/occupied-listener.ready"
    local listener_log="$TEMP_DIR/occupied-listener.log"
    local ready_pid=""
    local attempt
    node "$ROOT/scripts/contract-listener.mjs" "$ready_file" >"$listener_log" 2>&1 &
    LISTENER_PID=$!
    for ((attempt = 0; attempt < 100; attempt++)); do
        [ -s "$ready_file" ] && break
        kill -0 "$LISTENER_PID" 2>/dev/null || break
        sleep 0.05
    done
    if [ ! -s "$ready_file" ]; then
        cat "$listener_log" >&2
        fail "the occupied-port listener did not publish readiness"
    fi
    read -r ready_pid occupied_port server_port < "$ready_file"
    if [ "$ready_pid" != "$LISTENER_PID" ] ||
        ! lsof -a -p "$LISTENER_PID" -nP -iTCP:"$occupied_port" -sTCP:LISTEN -t | grep -Fxq "$LISTENER_PID"; then
        cat "$listener_log" >&2
        fail "the occupied-port fixture does not own its recorded listener"
    fi

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
    kill -0 "$LISTENER_PID" 2>/dev/null || fail "occupied-port refusal killed the unrelated listener"

    kill "$LISTENER_PID" 2>/dev/null || true
    wait "$LISTENER_PID" 2>/dev/null || true
    LISTENER_PID=""
}

setup_mock_tools() {
    mkdir -p "$MOCK_BIN"

    cat > "$MOCK_BIN/mkdir" <<'EOF'
#!/usr/bin/env bash
for argument in "$@"; do
    if [ "$argument" = "$GEOROIDS_CONTRACT_LOCK_DIR" ]; then
        printf 'lock acquisition attempted\n' > "$GEOROIDS_CONTRACT_DEV_PID_FILE.lock-attempt"
    fi
done
exec "$GEOROIDS_CONTRACT_REAL_MKDIR" "$@"
EOF

    cat > "$MOCK_BIN/lsof" <<'EOF'
#!/usr/bin/env bash
# Availability probes see free ports; readiness sees the owned mock server.
    if [ "${GEOROIDS_CONTRACT_MODE:-}" = port-inspection-status-one ]; then
        echo "simulated lsof inspection failure (status 1)" >&2
        exit 1
    fi
    if [ "${GEOROIDS_CONTRACT_MODE:-}" = port-inspection-failure ]; then
        echo "simulated lsof inspection failure (status 2)" >&2
        exit 2
    fi
if [[ " $* " == *" -t "* ]] && [ -s "$GEOROIDS_CONTRACT_DEV_PID_FILE" ]; then
    if [ "$GEOROIDS_CONTRACT_MODE" = readiness-inspection-failure ]; then
        echo "simulated owned-listener inspection failure (status 1)" >&2
        exit 1
    fi
    if [ "$GEOROIDS_CONTRACT_MODE" = readiness-unowned-listener ]; then
        printf '%s\n' 900000000
        exit 0
    fi
    cat "$GEOROIDS_CONTRACT_DEV_PID_FILE"
    exit 0
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
        printf '%s\n' "$*" > "$GEOROIDS_CONTRACT_DEV_PID_FILE.proxy-command"
        while [ "$#" -gt 0 ]; do
            if [ "$1" = --port ]; then shift; proxy_port="$1"; fi
            if [ "$1" = --ready ]; then shift; printf '%s' "$proxy_port" > "$1"; fi
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
mkdir -p dist/assets
printf '<script src="/assets/game.js"></script>\n' > dist/index.html
printf '{"releaseSha":"fixture"}\n' > dist/release.json
printf 'fixture client\n' > dist/assets/game.js
EOF

    cat > "$MOCK_BIN/ps" <<'EOF'
#!/usr/bin/env bash
# Admission inspects its supervisor independently of runner cleanup fixtures.
case " $* " in
    *" ppid=,stat=,lstart= "*|*" pid=,pgid=,stat= "*) exec /bin/ps "$@" ;;
esac
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-ps-status-one ] && [ -s "$GEOROIDS_CONTRACT_TEST_PID_FILE" ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
    : > "$GEOROIDS_CONTRACT_FAILURE_MARKER"
    echo "simulated ps inspection failure (status 1)" >&2
    exit 1
fi
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-ps-failure ] && [ -s "$GEOROIDS_CONTRACT_TEST_PID_FILE" ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
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

if [ "$GEOROIDS_CONTRACT_MODE" = watchdog-cleanup-alarm ] &&
    [ -s "$GEOROIDS_CONTRACT_TEST_PID_FILE" ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
    case " $* " in
        *" lstart="*)
            IFS= read -r test_pid < "$GEOROIDS_CONTRACT_TEST_PID_FILE"
            # The mocked test must already be gone. Authenticate the runner as
            # our ancestor and the inspected watchdog as its direct child.
            if ! kill -0 "$test_pid" 2>/dev/null; then
                IFS= read -r runner_pid < "$GEOROIDS_CONTRACT_LOCK_DIR/pid"
                ancestor="$PPID"
                for ((depth = 0; depth < 16 && ancestor != runner_pid && ancestor > 1; depth++)); do
                    ancestor="$(/bin/ps -p "$ancestor" -o ppid=)" || exit 2
                done
                [ "$ancestor" -eq "$runner_pid" ] || exit 2
                inspected_parent="$(/bin/ps -p "$pid" -o ppid=)" || exit 2
                [ "$inspected_parent" -eq "$runner_pid" ] || exit 2
                printf '%s\n' 'completed test; injecting alarm during watchdog cleanup' > "$GEOROIDS_CONTRACT_FAILURE_MARKER"
                kill -ALRM "$runner_pid" || exit 2
            fi
            ;;
    esac
fi

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
if [ "$GEOROIDS_CONTRACT_MODE" = process-tree-pgrep-failure ] && [ -s "$GEOROIDS_CONTRACT_TEST_PID_FILE" ] && [ ! -e "$GEOROIDS_CONTRACT_FAILURE_MARKER" ]; then
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

    cat > "$MOCK_BIN/rm" <<'EOF'
#!/usr/bin/env bash
if [ "$GEOROIDS_CONTRACT_MODE" = log-remove-failure ]; then
    for path in "$@"; do
        case "$path" in
            logs/client.log|logs/server.log)
                echo "simulated test-log removal failure" >&2
                exit 1
                ;;
        esac
    done
fi
exec "$GEOROIDS_CONTRACT_REAL_RM" "$@"
EOF

    cat > "$MOCK_BIN/touch" <<'EOF'
#!/usr/bin/env bash
if [ "$GEOROIDS_CONTRACT_MODE" = log-touch-failure ]; then
    for path in "$@"; do
        case "$path" in
            logs/client.log|logs/server.log)
                echo "simulated test-log creation failure" >&2
                exit 1
                ;;
        esac
    done
fi
exec "$GEOROIDS_CONTRACT_REAL_TOUCH" "$@"
EOF

    chmod +x "$MOCK_BIN/lsof" "$MOCK_BIN/curl" "$MOCK_BIN/npx" "$MOCK_BIN/ps" "$MOCK_BIN/pgrep" "$MOCK_BIN/rmdir" "$MOCK_BIN/rm" "$MOCK_BIN/touch" "$MOCK_BIN/npm" "$MOCK_BIN/mkdir"
}

run_mock_runner() {
    local mode="$1"
    local max_duration="$2"
    local output_file="$3"
    shift 3
    local vite_port=59993 server_port=59994 proxy_port="${GEOROIDS_TEST_PROXY_PORT:-59995}"
    if [ "${GEOROIDS_CONTRACT_AUTOMATIC_PORTS:-false}" = true ]; then
        vite_port="${GEOROIDS_TEST_VITE_PORT:-}"
        server_port="${GEOROIDS_TEST_SERVER_PORT:-}"
        proxy_port="${GEOROIDS_TEST_PROXY_PORT:-}"
    fi
    rm -f \
        "$MOCK_DEV_PID_FILE" \
        "$MOCK_TEST_PID_FILE" \
        "$MOCK_DEV_CHILD_PID_FILE" \
        "$MOCK_TEST_CHILD_PID_FILE" \
        "$MOCK_FAILURE_MARKER_FILE" "$MOCK_DEV_PID_FILE.proxy" "$MOCK_DEV_PID_FILE.session" "$MOCK_DEV_PID_FILE.proxy-command" \
        "$MOCK_TEST_PID_FILE.command" "$MOCK_DEV_PID_FILE.build" \
        "$MOCK_DEV_PID_FILE.lock-attempt" "$TEMP_DIR/final-runner.json"
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
        GEOROIDS_CONTRACT_REAL_RM="$REAL_RM" \
        GEOROIDS_CONTRACT_REAL_TOUCH="$REAL_TOUCH" \
        GEOROIDS_CONTRACT_REAL_MKDIR="$REAL_MKDIR" \
        GEOROIDS_CONTRACT_FAILURE_MARKER="$MOCK_FAILURE_MARKER_FILE" \
        GEOROIDS_TEST_RUNNER_RECEIPT="$TEMP_DIR/final-runner.json" \
        GEOROIDS_TEST_MAX_DURATION_SECONDS="$max_duration" \
        GEOROIDS_TEST_VITE_PORT="$vite_port" \
        GEOROIDS_TEST_SERVER_PORT="$server_port" \
        GEOROIDS_TEST_PROXY_PORT="$proxy_port" \
        "$RUNNER" "$@" > "$output_file" 2>&1
}

assert_selector_rejected() {
    local name="$1"
    local diagnostic="$2"
    shift 2
    local output_file="$TEMP_DIR/rejected-selector-$name.txt"
    local exit_code=0
    run_mock_runner success 10 "$output_file" "$@" || exit_code=$?
    [ "$exit_code" -eq 64 ] || { cat "$output_file" >&2; fail "$name did not refuse the invalid selection (exit $exit_code)"; }
    grep -Fq "$diagnostic" "$output_file" || { cat "$output_file" >&2; fail "$name did not identify the invalid selection"; }
    [ ! -e "$MOCK_DEV_PID_FILE.lock-attempt" ] || fail "$name attempted lock acquisition"
    [ ! -e "$MOCK_DEV_PID_FILE" ] || fail "$name started services"
    [ ! -e "$MOCK_TEST_PID_FILE.command" ] || fail "$name invoked tests"
    [ ! -e "$TEMP_DIR/final-runner.json" ] || fail "$name reached child cleanup receipts"
    if grep -Fq 'Checking that test ports' "$output_file"; then fail "$name reached service inspection"; fi
    assert_lock_released
}

assert_missing_selector_rejected() {
    local name="$1"
    local missing="$2"
    shift 2
    assert_selector_rejected "$name" "Explicit test file does not exist: $missing" "$@"
}

assert_vitest_boolean_options_keep_selectors() {
    local option
    local options_file="$TEMP_DIR/vitest-boolean-options.txt"
    # Match the installed public CLI metadata rather than duplicating the
    # runner's arity list in its test. Dependency upgrades must keep this proof.
    node --input-type=module - "$ROOT" "$options_file" <<'NODE'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, output] = process.argv.slice(2);
const { createCLI } = await import(pathToFileURL(join(root, 'node_modules/vitest/dist/node.js')).href);
const options = createCLI().globalCommand.options
    .filter(option => option.isBoolean && option.name !== 'isolate' && option.name !== 'fileParallelism' && !option.name.startsWith('sequence.'))
    .map(option => `--${option.name}`);
if (options.length === 0) throw new Error('Vitest CLI returned no boolean option metadata');
writeFileSync(output, [...new Set(options)].sort().join('\n') + '\n');
NODE
    while IFS= read -r option; do
        assert_missing_selector_rejected "boolean-${option#--}" "$MISSING_TEST" \
            "$SELECTED_TEST" "$option" "$MISSING_TEST"
    done < "$options_file"
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

clear_proven_fixture_barriers() {
    local pid_file
    # Only this script's isolated Git fixture is eligible for recovery. Every
    # recorded real process must be dead before clearing deliberately failed proof.
    for pid_file in "$MOCK_DEV_PID_FILE.proxy" "$MOCK_TEST_CHILD_PID_FILE" \
        "$MOCK_TEST_PID_FILE" "$MOCK_DEV_CHILD_PID_FILE" "$MOCK_DEV_PID_FILE"; do
        if [ -s "$pid_file" ]; then assert_pid_stopped "$pid_file" "fixture recovery"; fi
    done
    [ "$CONTRACT_GIT_DIR" = "$EXPECTED_GIT_DIR" ] || fail "recovery escaped the private fixture"
    [ -d "$CONTRACT_GIT_DIR/georoids-validation-checkout.lock" ] || fail "unproven cleanup released checkout ownership"
    [ -f "$CONTRACT_GIT_DIR/georoids-validation-queue/000000000001/active" ] || fail "unproven cleanup released heavy admission"
    "$REAL_RM" -rf "$LOCK_DIR" "$CONTRACT_GIT_DIR/georoids-validation-checkout.lock" \
        "$CONTRACT_GIT_DIR/georoids-validation-queue"
    assert_lock_released
}

assert_cleanup_barriers_retained() {
    [ -f "$LOCK_DIR/cleanup-failed.json" ] || fail "failed cleanup did not retain its runner barrier"
    clear_proven_fixture_barriers
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
    assert_cleanup_barriers_retained
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
    assert_cleanup_barriers_retained
}

assert_final_failure_receipt() {
    node - "$TEMP_DIR/final-runner.json" "$1" "$2" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const [path, status, lockReleased] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path));
assert.equal(receipt.exitCode, Number(status));
assert.equal(receipt.cleanupSucceeded, false);
assert.equal(receipt.lockReleased, lockReleased === 'true');
assert.equal(receipt.success, false);
NODE
}

assert_impaired_benchmark_cleanup() {
    local mode="$1"
    local expected="$2"
    local output_file="$TEMP_DIR/proxy-$mode.txt"
    local status=0
    local session
    local max_duration=10
    # Success measures proxy cleanup; only the timeout fixture exercises the
    # one-second watchdog. Success uses the other success fixtures' budget.
    if [ "$mode" = timeout ]; then max_duration=1; fi
    run_mock_runner "$mode" "$max_duration" "$output_file" --benchmark-client --network degraded --seconds 1 || status=$?
    [ "$status" -eq "$expected" ] || { cat "$output_file" >&2; fail "proxy $mode exit $status, expected $expected"; }
    grep -Fxq 'ws://localhost:59995/ws' "$MOCK_DEV_PID_FILE.build" || fail 'client build bypassed ready proxy'
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "proxy $mode"
    IFS= read -r session < "$MOCK_DEV_PID_FILE.session"
    [ ! -e "$session" ] || fail "proxy $mode leaked private session directory"
    assert_lock_released
    node - "$CONTRACT_ROOT" "$session" "$expected" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const [root, session, expected] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, '.performance', `runner-${path.basename(session)}`, 'runner.json')));
assert.equal(receipt.kind, 'georoids-runner-final');
assert.equal(receipt.exitCode, Number(expected));
assert.equal(receipt.cleanupSucceeded, true);
assert.equal(receipt.sessionRemoved, true);
assert.equal(receipt.lockReleased, true);
assert.equal(receipt.success, Number(expected) === 0);
NODE
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
    if [ "$mode" = benchmark-client ]; then
        grep -Fxq 'ws://localhost:59995/ws' "$MOCK_DEV_PID_FILE.build" || fail 'clean client bypassed its transparent counting proxy'
        grep -Fq -- '--network clean' "$MOCK_DEV_PID_FILE.proxy-command" || fail 'clean client lost proxy profile'
        grep -Fq -- '--control ' "$MOCK_DEV_PID_FILE.proxy-command" || fail 'clean client lost private live counter path'
        assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "clean benchmark proxy"
        local session
        IFS= read -r session < "$MOCK_DEV_PID_FILE.session"
        [ ! -e "$session" ] || fail 'clean client leaked private proxy session'
    else
        grep -Fxq 'ws://localhost:59994/ws' "$MOCK_DEV_PID_FILE.build" || fail "$mode did not build for its owned server"
    fi
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "$mode driver"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "$mode server"
    assert_lock_released
}

assert_frozen_benchmark_reuse() {
    local output_file="$TEMP_DIR/frozen-build.txt"
    local receipt="$CONTRACT_ROOT/.performance/benchmark-client-build.json"
    if ! run_mock_runner success 10 "$output_file" --benchmark-client --seconds 1; then
        cat "$output_file" >&2
        fail "initial frozen client build failed"
    fi
    cp "$receipt" "$TEMP_DIR/frozen-build.before.json"
    if ! run_mock_runner success 10 "$output_file" --benchmark-client --reuse-build --seconds 1; then
        cat "$output_file" >&2
        fail "unchanged frozen client could not be reused"
    fi
    [ ! -e "$MOCK_DEV_PID_FILE.build" ] || fail "reuse rebuilt the frozen client"
    cmp "$receipt" "$TEMP_DIR/frozen-build.before.json" || fail "reuse replaced its build proof"
    grep -Fxq -- '--no-install tsx benchmarks/realtime-client.ts --seconds 1' "$MOCK_TEST_PID_FILE.command" || fail "reuse flag leaked into client arguments"
    assert_pid_stopped "$MOCK_TEST_PID_FILE" "reused benchmark driver"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "reused benchmark server"
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "reused clean benchmark proxy"
    assert_lock_released

    if ! run_mock_runner success 10 "$output_file" --benchmark-client --reuse-build --network degraded --seconds 1; then
        cat "$output_file" >&2
        fail 'changing impairment on the same owned endpoint invalidated the frozen build'
    fi
    [ ! -e "$MOCK_DEV_PID_FILE.build" ] || fail 'impairment change rebuilt frozen assets'
    cmp "$receipt" "$TEMP_DIR/frozen-build.before.json" || fail 'impairment change replaced build proof'
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "reused degraded benchmark proxy"
    assert_lock_released

    local status=0
    GEOROIDS_TEST_PROXY_PORT=59996 run_mock_runner success 10 "$output_file" --benchmark-client --reuse-build --network degraded --seconds 1 || status=$?
    [ "$status" -eq 1 ] || fail "different proxy endpoint retained frozen build"
    grep -Fq 'Reusable build inputs differ' "$output_file" || fail "endpoint mismatch lost its reason"
    [ ! -e "$MOCK_DEV_PID_FILE" ] || fail "invalid reuse started the owned server pair"
    [ ! -e "$MOCK_TEST_PID_FILE" ] || fail "invalid reuse started the measurement driver"
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" "rejected reuse proxy"
    assert_lock_released
}

assert_completed_test_ignores_watchdog_cleanup_alarm() {
    local output_file="$TEMP_DIR/watchdog-cleanup-alarm.txt"
    if ! run_mock_runner watchdog-cleanup-alarm 10 "$output_file" tests/integration/server/; then
        cat "$output_file" >&2
        fail 'completed test became a timeout during watchdog cleanup'
    fi
    [ -s "$MOCK_FAILURE_MARKER_FILE" ] || fail 'watchdog cleanup alarm was not injected'
    node - "$TEMP_DIR/final-runner.json" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const receipt = JSON.parse(fs.readFileSync(process.argv[2]));
assert.equal(receipt.exitCode, 0);
assert.equal(receipt.timedOut, false);
assert.equal(receipt.cleanupSucceeded, true);
assert.equal(receipt.success, true);
NODE
    assert_pid_stopped "$MOCK_TEST_PID_FILE" 'completed test'
    assert_pid_stopped "$MOCK_DEV_PID_FILE" 'completed-test dev server'
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" 'completed-test dev-server child'
    assert_lock_released
}

assert_automatic_frozen_benchmark_reuse() {
    local build_output="$TEMP_DIR/automatic-build.txt"
    local reuse_output="$TEMP_DIR/automatic-reuse.txt"
    local receipt="$CONTRACT_ROOT/.performance/benchmark-client-build.json"
    local GEOROIDS_CONTRACT_AUTOMATIC_PORTS=true
    local GEOROIDS_TEST_VITE_PORT='' GEOROIDS_TEST_SERVER_PORT='' GEOROIDS_TEST_PROXY_PORT=''
    if ! run_mock_runner success 10 "$build_output" --benchmark-client --seconds 1; then
        cat "$build_output" >&2
        fail 'automatic-port client build failed'
    fi
    cp "$receipt" "$TEMP_DIR/automatic-build.before.json"
    if ! run_mock_runner success 10 "$reuse_output" --benchmark-client --reuse-build --seconds 1; then
        cat "$reuse_output" >&2
        fail 'automatic-port frozen client could not be reused'
    fi
    [ "$(grep '^Owned test ports:' "$build_output")" = "$(grep '^Owned test ports:' "$reuse_output")" ] || fail 'reuse changed automatically selected endpoints'
    [ ! -e "$MOCK_DEV_PID_FILE.build" ] || fail 'automatic reuse rebuilt the frozen client'
    cmp "$receipt" "$TEMP_DIR/automatic-build.before.json" || fail 'automatic reuse replaced its build proof'
    assert_pid_stopped "$MOCK_TEST_PID_FILE" 'automatic reuse driver'
    assert_pid_stopped "$MOCK_DEV_PID_FILE" 'automatic reuse server'
    assert_pid_stopped "$MOCK_DEV_PID_FILE.proxy" 'automatic reuse proxy'
    assert_lock_released

    # A recorded endpoint is not authority over a new listener. Use real socket
    # and process inspection here, with no mock tools or explicit port overrides.
    local ready_file="$TEMP_DIR/reused-port.ready"
    node --input-type=module - "$receipt" "$ready_file" <<'NODE' > "$TEMP_DIR/reused-port-listener.log" 2>&1 &
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
const [receipt, ready] = process.argv.slice(2);
const port = JSON.parse(readFileSync(receipt)).inputs.ports[0];
createServer().listen(port, '127.0.0.1', () => writeFileSync(ready, String(port)));
NODE
    LISTENER_PID=$!
    local attempt status=0
    for ((attempt = 0; attempt < 100; attempt++)); do
        [ -s "$ready_file" ] && break
        kill -0 "$LISTENER_PID" 2>/dev/null || break
        sleep 0.05
    done
    [ -s "$ready_file" ] || fail 'reused-port listener failed to bind'
    env -u GEOROIDS_TEST_VITE_PORT -u GEOROIDS_TEST_SERVER_PORT -u GEOROIDS_TEST_PROXY_PORT \
        "$RUNNER" --benchmark-client --reuse-build --seconds 1 > "$reuse_output" 2>&1 || status=$?
    [ "$status" -eq 1 ] || { cat "$reuse_output" >&2; fail 'occupied recovered port was not refused'; }
    grep -Fq 'already in use' "$reuse_output" || fail 'recovered port refusal lost its reason'
    kill -0 "$LISTENER_PID" 2>/dev/null || fail 'recovered port refusal killed the unrelated listener'
    assert_lock_released
    kill "$LISTENER_PID"
    wait "$LISTENER_PID" 2>/dev/null || true
    LISTENER_PID=''
}

assert_invalid_proxy_ports_rejected() {
    local port
    local status
    local output_file="$TEMP_DIR/proxy-invalid-port.txt"
    for port in 0 65536 59993 59994; do
        status=0
        GEOROIDS_TEST_PROXY_PORT="$port" run_mock_runner success 10 "$output_file" --benchmark-client --seconds 1 || status=$?
        [ "$status" -eq 64 ] || { cat "$output_file" >&2; fail "invalid proxy port $port exit $status"; }
        grep -Fq 'GEOROIDS_TEST_PROXY_PORT must be a valid TCP port distinct' "$output_file" || fail 'invalid proxy port lost its reason'
        [ ! -e "$MOCK_DEV_PID_FILE.proxy" ] || fail 'invalid proxy port started a proxy'
        [ ! -e "$MOCK_DEV_PID_FILE" ] || fail 'invalid proxy port started an owned server'
        [ ! -e "$MOCK_TEST_PID_FILE" ] || fail 'invalid proxy port started a measurement'
        assert_lock_released
    done
}

assert_invalid_build_reuse_rejected() {
    local name="$1"
    shift
    local output_file="$TEMP_DIR/reuse-$name.txt"
    local status=0
    "$RUNNER" "$@" > "$output_file" 2>&1 || status=$?
    [ "$status" -eq 64 ] || fail "$name did not reject unsupported build reuse"
    grep -Fq 'supported only immediately after --benchmark-client' "$output_file" || fail "$name lost its parsing reason"
    if grep -Fq 'Checking that test ports' "$output_file"; then
        fail "$name reached service startup"
    fi
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

assert_log_preparation_failure_is_not_success() {
    local mode="$1"
    local expected_message="$2"
    local output_file="$TEMP_DIR/$mode.txt"
    local exit_code
    if run_mock_runner "$mode" 10 "$output_file" tests/integration/server/; then
        exit_code=0
    else
        exit_code=$?
    fi
    [ "$exit_code" -eq 1 ] || {
        cat "$output_file" >&2
        fail "$mode allowed the runner to continue after log preparation failed (exit $exit_code)"
    }
    grep -Fq "$expected_message" "$output_file" || {
        cat "$output_file" >&2
        fail "$mode did not identify the failed log operation"
    }
    [ ! -e "$MOCK_DEV_PID_FILE" ] || fail "$mode started a dev server after log preparation failed"
    [ ! -e "$MOCK_TEST_PID_FILE" ] || fail "$mode launched Vitest after log preparation failed"
    [ ! -e "$MOCK_TEST_PID_FILE.command" ] || fail "$mode invoked the test command after log preparation failed"
    if grep -Fq "Running tests" "$output_file" || grep -Fq "Tests completed successfully" "$output_file"; then
        cat "$output_file" >&2
        fail "$mode reported test execution or success after log preparation failed"
    fi
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
    clear_proven_fixture_barriers
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
    assert_cleanup_barriers_retained
}

assert_readiness_failure_stops_before_tests() {
    local mode="$1"
    local expected_message="$2"
    local output_file="$TEMP_DIR/$mode.txt"
    local status=0
    run_mock_runner "$mode" 10 "$output_file" tests/integration/server/ || status=$?
    [ "$status" -eq 1 ] || { cat "$output_file" >&2; fail "$mode did not refuse startup (exit $status)"; }
    grep -Fq "$expected_message" "$output_file" || {
        cat "$output_file" >&2
        fail "$mode did not preserve its readiness failure reason"
    }
    [ ! -e "$MOCK_TEST_PID_FILE" ] || fail "$mode launched tests without an owned, inspected listener"
    [ ! -e "$MOCK_TEST_PID_FILE.command" ] || fail "$mode invoked tests before readiness"
    assert_pid_stopped "$MOCK_DEV_PID_FILE" "$mode dev server"
    assert_pid_stopped "$MOCK_DEV_CHILD_PID_FILE" "$mode dev-server child"
    assert_lock_released
}

assert_native_cache_rejected() {
    local output_file="$TEMP_DIR/native-cache-rejected.txt"
    local exit_code
    if "$RUNNER" "$@" > "$output_file" 2>&1; then exit_code=0; else exit_code=$?; fi
    [ "$exit_code" -eq 64 ] || fail "native cache option was not rejected early"
    grep -Fq "Native compile-cache options require --discovery-node" "$output_file" || fail "native cache rejection did not identify its boundary"
    if grep -Fq "Checking that test ports" "$output_file"; then fail "native cache rejection reached startup"; fi
    assert_lock_released
}
assert_native_cache_rejected --native-compile-cache=cold
assert_native_cache_rejected --shards=6 --native-compile-cache=disabled
assert_native_cache_rejected --discover-integration --native-compile-cache=cold
assert_native_cache_rejected --discovery-node --native-compile-cache=unknown

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
assert_rejected "partial-shard" --shard=1/6
assert_invalid_duration_rejected
assert_invalid_build_rejected
assert_occupied_port_rejected
setup_mock_tools
SELECTED_TEST=tests/integration/server/selected-pilot.test.ts
MISSING_TEST=tests/integration/server/misspelled-pilot.test.ts
assert_missing_selector_rejected mixed "$MISSING_TEST" "$SELECTED_TEST" "$MISSING_TEST"
assert_missing_selector_rejected absolute "$CONTRACT_ROOT/$MISSING_TEST" "$SELECTED_TEST" "$CONTRACT_ROOT/$MISSING_TEST"
assert_missing_selector_rejected dot-relative "./$MISSING_TEST" "$SELECTED_TEST" "./$MISSING_TEST"
assert_missing_selector_rejected spec missing-pilot.spec.js "$SELECTED_TEST" missing-pilot.spec.js
assert_missing_selector_rejected after-boolean "$MISSING_TEST" "$SELECTED_TEST" --hideSkippedTests "$MISSING_TEST"
assert_missing_selector_rejected after-negation "$MISSING_TEST" "$SELECTED_TEST" --no-color "$MISSING_TEST"
assert_missing_selector_rejected boolean-equals "$MISSING_TEST" "$SELECTED_TEST" "--globals=$MISSING_TEST"
assert_missing_selector_rejected after-value "$MISSING_TEST" "$SELECTED_TEST" --testNamePattern "$MISSING_TEST" "$MISSING_TEST"
assert_selector_rejected missing-after-separator 'Arguments after -- are unsupported' "$SELECTED_TEST" -- "$MISSING_TEST"
assert_selector_rejected valid-after-separator 'Arguments after -- are unsupported' "$SELECTED_TEST" -- \
    tests/integration/browser/sanity/game-initializes-with-arena-and-starting-state.test.ts
assert_missing_selector_rejected line "$MISSING_TEST" "$SELECTED_TEST" "$MISSING_TEST:12"
assert_missing_selector_rejected repeated-location "$SELECTED_TEST:12" "$SELECTED_TEST" "$SELECTED_TEST:12:34"
assert_missing_selector_rejected nonnumeric-location "$SELECTED_TEST:typo" "$SELECTED_TEST" "$SELECTED_TEST:typo"
assert_vitest_boolean_options_keep_selectors
assert_vitest_config valid-file vitest.config.ts "$SELECTED_TEST"
assert_vitest_config valid-absolute-file vitest.config.ts "$CONTRACT_ROOT/$SELECTED_TEST"
assert_vitest_config valid-file-line vitest.config.ts "$SELECTED_TEST:12"
assert_vitest_config empty-separator vitest.config.ts "$SELECTED_TEST" --
assert_vitest_config file-like-option-values vitest.config.ts "$SELECTED_TEST" \
    --testNamePattern "$MISSING_TEST" --exclude "$MISSING_TEST" --outputFile.json "$MISSING_TEST"
assert_vitest_config short-and-equal-option-values vitest.config.ts "$SELECTED_TEST" \
    -t "$MISSING_TEST" "--exclude=$MISSING_TEST" "--outputFile=$MISSING_TEST" "-t=$MISSING_TEST"
assert_vitest_config clustered-short-option-value vitest.config.ts "$SELECTED_TEST" -wt "$MISSING_TEST"
assert_vitest_config text-filter vitest.browser.config.ts selected-pilot
assert_vitest_config glob-filter vitest.config.ts 'tests/integration/server/*.test.ts'
assert_log_preparation_failure_is_not_success \
    log-remove-failure "Could not clear test logs"
assert_log_preparation_failure_is_not_success \
    log-touch-failure "Could not create fresh test logs"
assert_port_inspection_failure_is_not_success \
    port-inspection-failure 2 "simulated lsof inspection failure (status 2)"
assert_port_inspection_failure_is_not_success \
    port-inspection-status-one 2 "simulated lsof inspection failure (status 1)"
assert_readiness_failure_stops_before_tests \
    readiness-inspection-failure "simulated owned-listener inspection failure (status 1)"
assert_readiness_failure_stops_before_tests \
    readiness-unowned-listener "belongs to unowned listener PID 900000000"
assert_cleanup_state_contract
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
assert_invalid_proxy_ports_rejected
assert_live_benchmark_mode benchmark-load load
assert_frozen_benchmark_reuse
assert_automatic_frozen_benchmark_reuse
assert_completed_test_ignores_watchdog_cleanup_alarm
assert_invalid_build_reuse_rejected tests --reuse-build
assert_invalid_build_reuse_rejected load --benchmark-load --reuse-build
assert_invalid_build_reuse_rejected misplaced --benchmark-client --seconds 1 --reuse-build
assert_invalid_build_reuse_rejected value --benchmark-client --reuse-build=true
assert_test_timeout_cleans_owned_processes
assert_cleanup_failure_is_not_success
assert_final_failure_receipt 1 false
assert_cleanup_failure_preserves_test_failure
assert_final_failure_receipt 7 false
assert_lock_release_failure_is_not_success
assert_final_failure_receipt 1 false
assert_process_inspection_failure_is_not_success \
    process-tree-pgrep-failure "Could not enumerate children of owned process PID"
assert_process_inspection_failure_is_not_success \
    process-tree-ps-failure "Could not inspect process start time for PID"
assert_process_inspection_failure_is_not_success \
    process-tree-ps-status-one "Could not inspect process start time for PID" \
    "simulated ps inspection failure (status 1)"

node --test "$ROOT/scripts/benchmark-build-receipt.test.mjs"
echo "✅ Test-runner contract checks passed"
