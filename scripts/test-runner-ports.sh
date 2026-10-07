#!/usr/bin/env bash
# Port selection and readiness for the owned integration service pair.
((BASH_VERSINFO[0] >= 5)) || { echo "✗ $0 requires Bash >= 5, not $BASH_VERSION. Fix: brew install bash; rerun bash ~/code/dotagents/setup/install-local-agent-runtime.sh; open a new shell." >&2; exit 1; }

servers_ready() {
    # An HTTP responder alone cannot prove that our service owns the port.
    # Inspect the listener identities against the live owned process tree first.
    kill -0 "$DEV_PID" 2>/dev/null || return 1
    PROCESS_TREE_PIDS=()
    PROCESS_TREE_STARTS=()
    record_process_tree "$DEV_PID" || return 2
    local port listener owned pid inspection_status
    for port in "$TEST_VITE_PORT" "$TEST_SERVER_PORT"; do
        inspection_status=0
        process_inspect lsof -nP -t -iTCP:"$port" -sTCP:LISTEN || inspection_status=$?
        if [ "$inspection_status" -gt 1 ]; then
            report_process_inspection_failure "owned test listener" lsof "$port"
            return 2
        fi
        if [ "$inspection_status" -eq 1 ]; then return 1; fi
        [ -n "$PROCESS_INSPECTION_OUTPUT" ] || return 1
        for listener in $PROCESS_INSPECTION_OUTPUT; do
            owned=false
            for pid in "${PROCESS_TREE_PIDS[@]}"; do
                if [ "$listener" = "$pid" ]; then owned=true; break; fi
            done
            if [ "$owned" != true ]; then
                echo "❌ Test port $port belongs to unowned listener PID $listener" >&2
                return 2
            fi
        done
    done
    curl -sf --connect-timeout 1 --max-time 5 "http://localhost:$TEST_VITE_PORT/" > /dev/null 2>&1 && \
        curl -sf --connect-timeout 1 --max-time 5 "http://localhost:$TEST_SERVER_PORT/health" > /dev/null 2>&1
}

select_test_ports() {
    if [ "$REUSE_BENCHMARK_BUILD" = true ]; then
        local recorded_ports recorded_vite recorded_server recorded_proxy
        recorded_ports="$(node "$REPO_ROOT/scripts/benchmark-build-receipt.mjs" ports "$REPO_ROOT")" || return 1
        {
            IFS= read -r recorded_vite
            IFS= read -r recorded_server
            IFS= read -r recorded_proxy
        } <<< "$recorded_ports"
        REQUESTED_VITE_PORT="${REQUESTED_VITE_PORT:-$recorded_vite}"
        REQUESTED_SERVER_PORT="${REQUESTED_SERVER_PORT:-$recorded_server}"
        REQUESTED_PROXY_PORT="${REQUESTED_PROXY_PORT:-$recorded_proxy}"
    fi
    if [ "$RUN_MODE" = benchmark-client ] && [ -n "$REQUESTED_PROXY_PORT" ]; then
        if ! valid_port "$REQUESTED_PROXY_PORT" || \
            { [ -n "$REQUESTED_VITE_PORT" ] && [ "$REQUESTED_PROXY_PORT" -eq "$REQUESTED_VITE_PORT" ]; } || \
            { [ -n "$REQUESTED_SERVER_PORT" ] && [ "$REQUESTED_PROXY_PORT" -eq "$REQUESTED_SERVER_PORT" ]; }; then
            echo "❌ GEOROIDS_TEST_PROXY_PORT must be a valid TCP port distinct from the owned server and Vite ports" >&2
            return 64
        fi
    fi
    local selections
    selections="$(node "$REPO_ROOT/scripts/test-ports.mjs" "$REQUESTED_VITE_PORT" "$REQUESTED_SERVER_PORT" "$REQUESTED_PROXY_PORT")" || return 1
    {
        IFS= read -r TEST_VITE_PORT
        IFS= read -r TEST_SERVER_PORT
        IFS= read -r GEOROIDS_TEST_PROXY_PORT
    } <<< "$selections"
    export GEOROIDS_TEST_VITE_PORT="$TEST_VITE_PORT"
    export GEOROIDS_TEST_SERVER_PORT="$TEST_SERVER_PORT"
    export GEOROIDS_TEST_PROXY_PORT
    echo "Owned test ports: Vite=$TEST_VITE_PORT server=$TEST_SERVER_PORT proxy=$GEOROIDS_TEST_PROXY_PORT"
}
