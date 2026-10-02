#!/usr/bin/env bash

# Run integration tests with one repository-wide owner at a time. The lock lives
# in Git's common directory so linked worktrees sharing ports 3001/5173 also
# share the same serialization boundary.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }
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
REUSE_BENCHMARK_BUILD=false
COMPILE_CACHE_TREATMENT=""
BUILD_MODE="${GEOROIDS_TEST_BUILD:-development}"
SHARD_CHILD=false
SHARD_DIRECTORY=""
SHARD_ASSIGNMENT=""
case "${1:-}" in
    --shards=6) RUN_MODE=shards; shift ;;
    --discover-integration) RUN_MODE=discovery; shift ;;
    --discovery-node) RUN_MODE=discovery-node; shift ;;
    --coordinator-child) SHARD_CHILD=true; shift ;;
    --benchmark-client) RUN_MODE=benchmark-client; BUILD_MODE=production; shift ;;
    --benchmark-load) RUN_MODE=benchmark-load; BUILD_MODE=production; shift ;;
esac
if [ "${1:-}" = --reuse-build ] && [ "$RUN_MODE" = benchmark-client ]; then
    REUSE_BENCHMARK_BUILD=true
    shift
fi
if [ "$RUN_MODE" = discovery-node ]; then
    case "${1:-}" in
        --native-compile-cache=disabled) COMPILE_CACHE_TREATMENT=disabled; shift ;;
        --native-compile-cache=cold) COMPILE_CACHE_TREATMENT=cold; shift ;;
    esac
fi
for runner_argument in "$@"; do
    case "$runner_argument" in
        --reuse-build|--reuse-build=*)
            echo "❌ --reuse-build is supported only immediately after --benchmark-client" >&2
            exit 64
            ;;
        --native-compile-cache*)
            echo "❌ Native compile-cache options require --discovery-node and one supported treatment" >&2
            exit 64
            ;;
    esac
done
if [ -n "$COMPILE_CACHE_TREATMENT" ]; then
    if [ -n "${NODE_V8_COVERAGE:-}" ] || [[ "${NODE_OPTIONS:-}" =~ (compil(e|ation)[_-]cache|coverage) ]]; then
        echo "❌ Native compile-cache diagnostic refuses coverage or conflicting Node options" >&2
        exit 64
    fi
fi
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

is_boolean_vitest_option() {
    # CAC returns non-boolean values following these flags to its positional
    # filters. Other flags consume their next value, including file-like text.
    case "$1" in
        h|help|v|version|w|watch|ui|open|hideSkippedTests|\
        coverage|coverage.enabled|coverage.clean|coverage.cleanOnRerun|\
        coverage.reportOnFailure|coverage.allowExternal|coverage.skipFull|\
        coverage.thresholds.100|coverage.excludeAfterRemap|coverage.autoAttachSubprocess|\
        api.strictPort|api.allowExec|api.allowWrite|\
        isolate|globals|injectCjsGlobals|dom|browser.enabled|browser.headless|browser.ui|\
        browser.dependencySourcemaps|browser.trackUnhandledErrors|browser.traceView|\
        browser.traceView.enabled|browser.traceView.recordCanvas|browser.traceView.inlineImages|\
        browser.locators.exact|fileParallelism|passWithNoTests|logHeapUsage|detectAsyncLeaks|\
        allowOnly|dangerouslyIgnoreUnhandledErrors|sequence.shuffle|sequence.shuffle.files|\
        sequence.shuffle.tests|sequence.concurrent|diff.expand|diff.includeChangeCounts|\
        diff.omitAnnotationLines|diff.printBasicPrototype|expandSnapshotDiff|disableConsoleIntercept|\
        typecheck|typecheck.enabled|typecheck.only|typecheck.allowJs|typecheck.ignoreSourceErrors|\
        typecheck.build|cache|fsModuleCache|expect|expect.requireAssertions|expect.poll|\
        printConsoleTrace|includeTaskLocation|run|color|clearScreen|standalone|clearCache|\
        strictTags|sharedViteServer|experimental.importDurations|\
        experimental.importDurations.failOnDanger|experimental.importDurations.thresholds|\
        experimental.viteModuleRunner|experimental.nodeLoader|experimental.preParse|\
        experimental.diagnostics|experimental.diagnostics.isolate|\
        experimental.diagnostics.environment|experimental.diagnostics.import|\
        experimental.diagnostics.transform)
            return 0 ;;
        *) return 1 ;;
    esac
}

validate_explicit_test_file() {
    local selector="$1"
    local path
    # Leave directory, substring and glob filters to Vitest. A literal test file
    # is an explicit selection. Vitest strips only one final numeric :line;
    # preceding colons remain part of the selected filename.
    case "$selector" in
        *\**|*\?*|*\[*|*\]*) return 0 ;;
    esac
    if [[ "$selector" =~ \.(test|spec)\.[^/]+$ ]]; then
        path="$selector"
        if [[ "$path" =~ :[0-9]+$ ]]; then path="${path%:*}"; fi
        if [ ! -f "$path" ]; then
            echo "❌ Explicit test file does not exist: $path" >&2
            echo "   Refusing partial validation; correct the selected file before running tests." >&2
            return 1
        fi
    fi
    return 0
}

reject_missing_test_files() {
    local argument option value
    while [ "$#" -gt 0 ]; do
        argument="$1"
        shift
        case "$argument" in
            --)
                # CAC stores this tail in options['--']; Vitest ignores it
                # when selecting tests. Never silently validate only the head.
                if [ "$#" -gt 0 ]; then
                    echo "❌ Arguments after -- are unsupported by test-runner.sh; Vitest ignores that tail when selecting tests." >&2
                    echo "   Pass all selected test files and options before --, or omit the separator." >&2
                    return 1
                fi
                continue ;;
            --no-*|-no-*) continue ;;
            -*)
                option="${argument%%=*}"
                if [[ "$option" = --* ]]; then
                    option="${option#--}"
                else
                    # CAC expands short clusters; only the final flag gets a
                    # value. For example, -wt pattern uses the value for -t.
                    option="${option: -1}"
                fi
                value="${argument#*=}"
                if [[ "$argument" != *=* ]] || [ -z "$value" ]; then
                    if [ "$#" -eq 0 ] || [[ "$1" = -* ]]; then continue; fi
                    value="$1"
                    shift
                fi
                if is_boolean_vitest_option "$option"; then
                    case "$value" in
                        true|false) ;;
                        *) validate_explicit_test_file "$value" || return 1 ;;
                    esac
                fi
                ;;
            *) validate_explicit_test_file "$argument" || return 1 ;;
        esac
    done
    return 0
}

# Refuse misspelled explicit selectors before lock acquisition, cleanup traps,
# receipts or any service/test children. Coordinator discovery and benchmarks
# have their own argument contracts.
if [ "$RUN_MODE" = tests ] && [ "$SHARD_CHILD" = false ]; then
    reject_missing_test_files "$@" || exit 64
fi

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
if [ "$SHARD_CHILD" = true ]; then RUNNER_RECEIPT=""; fi
RUNNER_STARTED_AT="$(date +%s)"
TEST_TIMED_OUT=false
CLEANUP_RUNNING=false
CLEANUP_FAILED=false
COORDINATOR_CONTROL=""
COORDINATOR_BIRTH=""
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

is_protected_vitest_option() {
    case "${1:-}" in
        --shard|--shard=*|--shards|--shards=*|--coordinator-child|--discover-integration|--discovery-node|\
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

retain_cleanup_state() {
    local state="$1"
    node "$REPO_ROOT/scripts/integration-shards.mjs" mark-lock "$COORDINATOR_CONTROL" "$$" "$LOCK_DIR" "$state"
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

await_coordinator_cleanup() {
    local coordinator_pid="$1"
    local deadline=$((SECONDS + 30))
    local fallback=false
    local validation=false
    local actual_birth=""
    actual_birth="$(ps -p "$coordinator_pid" -o lstart= 2>/dev/null)" || actual_birth=""
    if [ "$actual_birth" = "$COORDINATOR_BIRTH" ] && [ -n "$actual_birth" ]; then
        kill -TERM "$coordinator_pid" 2>/dev/null || true
    else
        fallback=true
    fi
    while kill -0 "$coordinator_pid" 2>/dev/null && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.1 || true; done
    if kill -0 "$coordinator_pid" 2>/dev/null; then fallback=true; fi
    if ! kill -0 "$coordinator_pid" 2>/dev/null; then wait "$coordinator_pid" 2>/dev/null || true; fi
    if [ "$fallback" = false ] && node "$REPO_ROOT/scripts/integration-shards.mjs" verify-stop "$COORDINATOR_CONTROL" "$$"         > "$COORDINATOR_CONTROL/receipt-validation.log" 2>&1; then
        validation=true
        rm -f "$LOCK_DIR/ownership-pending.json" "$LOCK_DIR/cleanup-failed.json" || return 1
    else
        fallback=true
    fi
    if [ "$fallback" = true ]; then
        echo "❌ Coordinator graceful cleanup or receipt validation failed; owned fallback required" >&2
        actual_birth="$(ps -p "$coordinator_pid" -o lstart= 2>/dev/null)" || actual_birth=""
        if [ -n "$actual_birth" ] && [ "$actual_birth" = "$COORDINATOR_BIRTH" ]; then terminate_process_tree "$coordinator_pid" || true; fi
        if node "$REPO_ROOT/scripts/integration-shards.mjs" fallback-stop "$COORDINATOR_CONTROL" "$$" \
            > "$COORDINATOR_CONTROL/fallback-cleanup.log" 2>&1; then
            rm -f "$LOCK_DIR/ownership-pending.json" "$LOCK_DIR/cleanup-failed.json" || return 1
        else
            retain_cleanup_state cleanup-failed || true
        fi
        wait "$coordinator_pid" 2>/dev/null || true
    fi
    printf '{"ownerPid":%s,"coordinatorPid":%s,"signal":"%s","graceSeconds":30,"receiptValidated":%s,"fallbackUsed":%s,"success":false}\n'         "$$" "$coordinator_pid" "$INTERRUPT_SIGNAL" "$validation" "$fallback" > "$COORDINATOR_CONTROL/owner-cancellation.json" || return 1
    [ "$validation" = true ] && [ "$fallback" = false ]
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
        if [ -n "$COORDINATOR_CONTROL" ]; then
            if ! await_coordinator_cleanup "$TEST_PID"; then cleanup_succeeded=false; fi
        elif ! terminate_process_tree "$TEST_PID"; then
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
    if [ "$SHARD_CHILD" = true ] && [ -n "$SHARD_DIRECTORY" ]; then
        if ! printf '{"runId":"%s","shard":%s,"exitCode":%s,"cleanupSucceeded":%s,"timedOut":%s}\n' \
            "$GEOROIDS_SHARD_RUN_ID" "${SHARD_ASSIGNMENT%/*}" "$exit_code" "$cleanup_succeeded" "$TEST_TIMED_OUT" \
            > "$SHARD_DIRECTORY/runner.json"; then
            echo "❌ Could not retain shard cleanup receipt" >&2
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

    if [ "$SHARD_CHILD" != true ]; then ensure_env_local || return 1; fi
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
    if [ "$RUN_MODE" = benchmark-client ]; then
        local proxy_port="${GEOROIDS_TEST_PROXY_PORT:-$((10#$TEST_SERVER_PORT + 1))}"
        if ! valid_port "$proxy_port" || [ "$proxy_port" -eq "$TEST_SERVER_PORT" ] || [ "$proxy_port" -eq "$TEST_VITE_PORT" ]; then
            echo "❌ GEOROIDS_TEST_PROXY_PORT must be a valid TCP port distinct from the owned server and Vite ports" >&2
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
    local client_command="vite --configLoader runner --port $TEST_VITE_PORT --strictPort"
    local server_entry=server.ts
    local server_env=.env.local
    if [ "$SHARD_CHILD" = true ]; then server_env=.env.example; fi
    if [ "$RUN_MODE" != tests ]; then
        server_entry=benchmarks/realtime-server.ts
    fi
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
        client_command="vite preview --configLoader runner --host 127.0.0.1 --port $TEST_VITE_PORT --strictPort"
    fi
    echo "🚀 Starting servers owned by this runner..."
    REGISTERING_CHILD=true
    (
        export NODE_ENV="$BUILD_MODE"
        export VITEST=false
        export PORT="$TEST_SERVER_PORT"
        if [ "$RUN_MODE" != tests ]; then
            export GEOROIDS_PERFORMANCE=1
        fi
        export VITE_WEBSOCKET_URL="ws://localhost:$TEST_SERVER_PORT/ws"
        GEOROIDS_WORLD_PATH=:memory: exec npx --no-install concurrently \
            --kill-others \
            --prefix-colors "blue.bold,green.bold" \
            --prefix "[{name}]" \
            --names "vite,network" \
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
        --configLoader=runner
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

    REGISTERING_CHILD=true
    VITEST_MAX_WORKERS=1 "${vitest_command[@]}" "${test_args[@]}" &
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
    local -a test_args=("$@")

    if ! reject_protected_vitest_arguments "${test_args[@]}"; then
        exit 64
    fi

    echo "🧪 Starting GeoRoids test runner..."
    if [ "$SHARD_CHILD" = true ]; then
        local authorization
        authorization="$(mktemp "${TMPDIR:-/tmp}/georoids-shard-auth.XXXXXX")" || exit 1
        if ! node "$REPO_ROOT/scripts/integration-shards.mjs" authorize "$$" "$PPID" "$REPO_ROOT" "$LOCK_DIR" > "$authorization"; then
            rm -f "$authorization"
            exit 1
        fi
        {
            IFS= read -r TEST_VITE_PORT
            IFS= read -r TEST_SERVER_PORT
            IFS= read -r SHARD_DIRECTORY
            IFS= read -r SHARD_ASSIGNMENT
        } < "$authorization"
        rm -f "$authorization" || exit 1
        export GEOROIDS_TEST_VITE_PORT="$TEST_VITE_PORT"
        export GEOROIDS_TEST_SERVER_PORT="$TEST_SERVER_PORT"
        export GEOROIDS_TEST_SESSION_DIR="$SHARD_DIRECTORY"
        export GEOROIDS_TEST_LOG_DIR="$SHARD_DIRECTORY/logs"
        export GEOROIDS_TEST_SCREENSHOTS_DIR="$SHARD_DIRECTORY/screenshots"
        export TMPDIR="$SHARD_DIRECTORY/tmp"
        export GEOROIDS_WORLD_PATH=:memory:
        test_args=(tests/integration/ "--shard=$SHARD_ASSIGNMENT" --reporter=verbose --reporter=json "--reporter=$REPO_ROOT/scripts/integration-timing-reporter.mjs" "--outputFile.json=$SHARD_DIRECTORY/vitest.json")
    else
        if ! acquire_lock "${test_args[@]}"; then exit 1; fi
    fi
    if [ "$RUN_MODE" = shards ] || [ "$RUN_MODE" = discovery ] || [ "$RUN_MODE" = discovery-node ]; then
        local argument
        for argument in "${test_args[@]}"; do
            case "$argument" in
                tests/integration|tests/integration/|--reporter=verbose) ;;
                *) echo "❌ Coordinated shards require complete integration discovery; unsupported argument: $argument" >&2; exit 64 ;;
            esac
        done
        local -a coordinator=(node "$REPO_ROOT/scripts/integration-shards.mjs" coordinate "$LOCK_DIR" "$$")
        if [ "$RUN_MODE" = discovery ]; then coordinator+=(--discover-only); fi
        if [ "$RUN_MODE" = discovery-node ]; then coordinator+=(--discovery-node); fi
        if [ -n "$COMPILE_CACHE_TREATMENT" ]; then coordinator+=("--native-compile-cache=$COMPILE_CACHE_TREATMENT"); fi
        mkdir -p "$REPO_ROOT/.performance/integration-shards" || exit 1
        COORDINATOR_CONTROL="$(mktemp -d "$REPO_ROOT/.performance/integration-shards/owner-XXXXXX")" || exit 1
        retain_cleanup_state ownership-pending || exit 1
        REGISTERING_CHILD=true
        GEOROIDS_COORDINATOR_CONTROL="$COORDINATOR_CONTROL" "${coordinator[@]}" &
        TEST_PID=$!
        COORDINATOR_BIRTH="$(ps -p "$TEST_PID" -o lstart=)" || exit 1
        honor_pending_interrupt
        local coordinator_status=0
        wait "$TEST_PID" || coordinator_status=$?
        if ! node "$REPO_ROOT/scripts/integration-shards.mjs" verify-exit "$COORDINATOR_CONTROL" "$$" \
            > "$COORDINATOR_CONTROL/receipt-validation.log" 2>&1; then
            echo "❌ Coordinator exit omitted valid cleanup evidence; owned fallback required" >&2
            if node "$REPO_ROOT/scripts/integration-shards.mjs" fallback-stop "$COORDINATOR_CONTROL" "$$" \
                > "$COORDINATOR_CONTROL/fallback-cleanup.log" 2>&1; then
                rm -f "$LOCK_DIR/ownership-pending.json" "$LOCK_DIR/cleanup-failed.json" || CLEANUP_FAILED=true
            else
                CLEANUP_FAILED=true
                retain_cleanup_state cleanup-failed || true
            fi
            coordinator_status=1
        else
            rm -f "$LOCK_DIR/ownership-pending.json" "$LOCK_DIR/cleanup-failed.json" || coordinator_status=1
        fi
        TEST_PID=""
        return "$coordinator_status"
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
