#!/usr/bin/env bash

# Shared process ownership and cleanup primitives for repository scripts.
# Callers retain their own session metadata and port policies; this file only
# records process identities and terminates the captured tree safely.

PROCESS_TREE_PIDS=()
PROCESS_TREE_STARTS=()

valid_pid() {
    case "${1:-}" in
        ''|0|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

process_start() {
    ps -p "$1" -o lstart= 2>/dev/null | sed 's/^ *//'
}

process_state() {
    ps -p "$1" -o stat= 2>/dev/null | sed 's/^ *//'
}

process_matches_start() {
    local pid="${1:-}"
    local expected_start="${2:-}"
    [ -n "$pid" ] && [ -n "$expected_start" ] && [ "$(process_start "$pid")" = "$expected_start" ]
}

process_is_active() {
    local pid="${1:-}"
    local expected_start="${2:-}"
    process_matches_start "$pid" "$expected_start" || return 1
    case "$(process_state "$pid")" in
        Z*|'') return 1 ;;
        *) return 0 ;;
    esac
}

record_process_tree() {
    local pid="${1:-}"
    local start_time
    local child
    local children
    local index
    local already_recorded=false
    valid_pid "$pid" || return 0
    [ "$pid" != "$$" ] || return 1

    start_time="$(process_start "$pid")"
    [ -n "$start_time" ] || return 0
    for ((index = 0; index < ${#PROCESS_TREE_PIDS[@]}; index++)); do
        if [ "${PROCESS_TREE_PIDS[$index]}" = "$pid" ] && \
            [ "${PROCESS_TREE_STARTS[$index]}" = "$start_time" ]; then
            already_recorded=true
            break
        fi
    done
    if [ "$already_recorded" = false ]; then
        PROCESS_TREE_PIDS+=("$pid")
        PROCESS_TREE_STARTS+=("$start_time")
    fi

    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    for child in $children; do
        record_process_tree "$child" || return 1
    done
}

signal_recorded_processes() {
    local signal_name="$1"
    local direction="$2"
    local index
    local first
    local last
    local step
    local pid
    local start_time

    if [ "$direction" = root-first ]; then
        first=0
        last=${#PROCESS_TREE_PIDS[@]}
        step=1
    else
        first=$((${#PROCESS_TREE_PIDS[@]} - 1))
        last=-1
        step=-1
    fi

    for ((index = first; index != last; index += step)); do
        pid="${PROCESS_TREE_PIDS[$index]}"
        start_time="${PROCESS_TREE_STARTS[$index]}"
        if process_is_active "$pid" "$start_time"; then
            kill "-$signal_name" "$pid" 2>/dev/null || true
        fi
    done
}

recorded_processes_are_active() {
    local index
    for ((index = 0; index < ${#PROCESS_TREE_PIDS[@]}; index++)); do
        if process_is_active "${PROCESS_TREE_PIDS[$index]}" "${PROCESS_TREE_STARTS[$index]}"; then
            return 0
        fi
    done
    return 1
}

report_active_recorded_processes() {
    local index
    local active=()
    for ((index = 0; index < ${#PROCESS_TREE_PIDS[@]}; index++)); do
        if process_is_active "${PROCESS_TREE_PIDS[$index]}" "${PROCESS_TREE_STARTS[$index]}"; then
            active+=("${PROCESS_TREE_PIDS[$index]}")
        fi
    done
    printf '%s' "${active[*]}"
}

# TERM gets a bounded grace period, KILL gets another, and each captured PID is
# checked against its recorded start time before it is signaled or accepted as
# still active. Zombies count as stopped while their parent finishes reaping.
terminate_process_tree() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0
    [ "$pid" != "$$" ] || return 1

    local attempt
    PROCESS_TREE_PIDS=()
    PROCESS_TREE_STARTS=()
    record_process_tree "$pid" || return 1
    [ "${#PROCESS_TREE_PIDS[@]}" -gt 0 ] || {
        wait "$pid" 2>/dev/null || true
        return 0
    }

    signal_recorded_processes TERM descendants-first
    for ((attempt = 0; attempt < 4; attempt++)); do
        recorded_processes_are_active || break
        sleep 0.05
    done

    if recorded_processes_are_active; then
        # Refresh the tree, then stop roots first so a TERM-resistant parent
        # cannot fork a new child during forced cleanup.
        record_process_tree "$pid" || return 1
        signal_recorded_processes KILL root-first
        for ((attempt = 0; attempt < 10; attempt++)); do
            recorded_processes_are_active || break
            sleep 0.05
        done
    fi

    if recorded_processes_are_active; then
        echo "❌ Owned process tree rooted at PID $pid did not stop (active PIDs: $(report_active_recorded_processes))" >&2
        return 1
    fi
    wait "$pid" 2>/dev/null || true
    return 0
}
