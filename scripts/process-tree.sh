#!/usr/bin/env bash

# Shared process inspection, ownership, and cleanup primitives for repository
# scripts. Callers retain their own session metadata and port policies; this
# file owns the bounded ps/lsof probe and terminates captured trees safely.

PROCESS_TREE_PIDS=()
PROCESS_TREE_STARTS=()
PROCESS_INSPECTION_OUTPUT=""
PROCESS_INSPECTION_DIAGNOSTIC=""
PROCESS_INSPECTION_STATUS=0

valid_pid() {
    case "${1:-}" in
        ''|0|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

# Run one ps/lsof probe while preserving the distinction between a normal
# no-match (exit 1 with no diagnostic) and an inspection failure. Callers use
# the returned status for their existing policy and read the bounded diagnostic
# through PROCESS_INSPECTION_DIAGNOSTIC when the probe failed.
process_inspect() {
    local command="$1"
    shift
    local diagnostic_file
    local inspection_status

    PROCESS_INSPECTION_OUTPUT=""
    PROCESS_INSPECTION_DIAGNOSTIC=""
    PROCESS_INSPECTION_STATUS=0
    if ! diagnostic_file="$(mktemp "${TMPDIR:-/tmp}/georoids-process-inspection.XXXXXX")"; then
        PROCESS_INSPECTION_STATUS=2
        PROCESS_INSPECTION_DIAGNOSTIC="could not create a temporary diagnostic file"
        return 2
    fi
    if PROCESS_INSPECTION_OUTPUT="$("$command" "$@" 2>"$diagnostic_file")"; then
        inspection_status=0
    else
        inspection_status=$?
    fi
    PROCESS_INSPECTION_STATUS="$inspection_status"
    if ! PROCESS_INSPECTION_DIAGNOSTIC="$(<"$diagnostic_file")"; then
        rm -f "$diagnostic_file" || true
        PROCESS_INSPECTION_STATUS=2
        PROCESS_INSPECTION_DIAGNOSTIC="could not read the inspection diagnostic"
        return 2
    fi
    if ! rm -f "$diagnostic_file"; then
        PROCESS_INSPECTION_STATUS=2
        PROCESS_INSPECTION_DIAGNOSTIC="could not remove the temporary diagnostic file"
        return 2
    fi
    if [ -n "$PROCESS_INSPECTION_DIAGNOSTIC" ]; then
        PROCESS_INSPECTION_DIAGNOSTIC="${PROCESS_INSPECTION_DIAGNOSTIC//$'\n'/ }"
        PROCESS_INSPECTION_DIAGNOSTIC="${PROCESS_INSPECTION_DIAGNOSTIC//$'\r'/ }"
        PROCESS_INSPECTION_DIAGNOSTIC="${PROCESS_INSPECTION_DIAGNOSTIC:0:400}"
        if [ "$inspection_status" -le 1 ]; then
            return 2
        fi
        return "$inspection_status"
    fi
    return "$inspection_status"
}

report_process_inspection_failure() {
    local description="$1"
    local tool="$2"
    local identifier="$3"
    local inspection_status="${PROCESS_INSPECTION_STATUS:-2}"
    if [ -n "${PROCESS_INSPECTION_DIAGNOSTIC:-}" ]; then
        printf '❌ Could not inspect %s %s with %s (exit %s): %s\n' \
            "$description" "$identifier" "$tool" "$inspection_status" "$PROCESS_INSPECTION_DIAGNOSTIC" >&2
    else
        printf '❌ Could not inspect %s %s with %s (exit %s); refusing to trust it.\n' \
            "$description" "$identifier" "$tool" "$inspection_status" >&2
    fi
}

process_start() {
    local output
    local ps_status
    if process_inspect ps -p "$1" -o lstart=; then
        output="$PROCESS_INSPECTION_OUTPUT"
        printf '%s\n' "$output" | sed 's/^ *//'
        return 0
    else
        ps_status=$?
        # ps exits 1 when the process has already gone away. That is a normal
        # cleanup race; other statuses mean process inspection itself failed.
        if [ "$ps_status" -eq 1 ]; then
            return 0
        fi
        report_process_inspection_failure "process start time for PID" ps "$1"
        return "$ps_status"
    fi
}

process_state() {
    local output
    local ps_status
    if process_inspect ps -p "$1" -o stat=; then
        output="$PROCESS_INSPECTION_OUTPUT"
        printf '%s\n' "$output" | sed 's/^ *//'
        return 0
    else
        ps_status=$?
        if [ "$ps_status" -eq 1 ]; then
            return 0
        fi
        report_process_inspection_failure "process state for PID" ps "$1"
        return "$ps_status"
    fi
}

process_matches_start() {
    local pid="${1:-}"
    local expected_start="${2:-}"
    local actual_start
    [ -n "$pid" ] && [ -n "$expected_start" ] || return 1
    actual_start="$(process_start "$pid")" || return $?
    [ "$actual_start" = "$expected_start" ]
}

process_is_active() {
    local pid="${1:-}"
    local expected_start="${2:-}"
    local state
    process_matches_start "$pid" "$expected_start" || return $?
    state="$(process_state "$pid")" || return $?
    case "$state" in
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
    local pgrep_status
    valid_pid "$pid" || return 0
    [ "$pid" != "$$" ] || return 1

    start_time="$(process_start "$pid")" || return $?
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

    if children="$(pgrep -P "$pid" 2>/dev/null)"; then
        :
    else
        pgrep_status=$?
        if [ "$pgrep_status" -eq 1 ]; then
            # pgrep uses exit 1 to report that the process has no children.
            children=""
        else
            echo "❌ Could not enumerate children of owned process PID $pid (pgrep exited $pgrep_status)" >&2
            return "$pgrep_status"
        fi
    fi
    for child in $children; do
        record_process_tree "$child" || return $?
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
    local active_status

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
        else
            active_status=$?
            if [ "$active_status" -gt 1 ]; then
                echo "❌ Could not verify owned process PID $pid before signaling (process inspection exited $active_status)" >&2
                return "$active_status"
            fi
        fi
    done
}

recorded_processes_are_active() {
    local index
    local active_status
    for ((index = 0; index < ${#PROCESS_TREE_PIDS[@]}; index++)); do
        active_status=0
        process_is_active "${PROCESS_TREE_PIDS[$index]}" "${PROCESS_TREE_STARTS[$index]}" || active_status=$?
        if [ "$active_status" -eq 0 ]; then
            return 0
        fi
        if [ "$active_status" -gt 1 ]; then
            return "$active_status"
        fi
    done
    return 1
}

report_active_recorded_processes() {
    local index
    local active=()
    local active_status
    for ((index = 0; index < ${#PROCESS_TREE_PIDS[@]}; index++)); do
        active_status=0
        process_is_active "${PROCESS_TREE_PIDS[$index]}" "${PROCESS_TREE_STARTS[$index]}" || active_status=$?
        if [ "$active_status" -eq 0 ]; then
            active+=("${PROCESS_TREE_PIDS[$index]}")
        fi
        if [ "$active_status" -gt 1 ]; then
            return "$active_status"
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
    local active_status
    PROCESS_TREE_PIDS=()
    PROCESS_TREE_STARTS=()
    record_process_tree "$pid" || return $?
    [ "${#PROCESS_TREE_PIDS[@]}" -gt 0 ] || {
        wait "$pid" 2>/dev/null || true
        return 0
    }

    signal_recorded_processes TERM descendants-first || return $?
    for ((attempt = 0; attempt < 4; attempt++)); do
        active_status=0
        recorded_processes_are_active || active_status=$?
        if [ "$active_status" -eq 0 ]; then
            sleep 0.05
            continue
        fi
        if [ "$active_status" -gt 1 ]; then
            echo "❌ Could not verify the owned process tree after TERM (process inspection exited $active_status)" >&2
            return "$active_status"
        fi
        break
    done

    active_status=0
    recorded_processes_are_active || active_status=$?
    if [ "$active_status" -eq 0 ]; then
        # Refresh the tree, then stop roots first so a TERM-resistant parent
        # cannot fork a new child during forced cleanup.
        record_process_tree "$pid" || return $?
        signal_recorded_processes KILL root-first || return $?
        for ((attempt = 0; attempt < 10; attempt++)); do
            active_status=0
            recorded_processes_are_active || active_status=$?
            if [ "$active_status" -eq 0 ]; then
                sleep 0.05
                continue
            fi
            if [ "$active_status" -gt 1 ]; then
                echo "❌ Could not verify the owned process tree after KILL (process inspection exited $active_status)" >&2
                return "$active_status"
            fi
            break
        done
    elif [ "$active_status" -gt 1 ]; then
        echo "❌ Could not verify the owned process tree after TERM (process inspection exited $active_status)" >&2
        return "$active_status"
    fi

    active_status=0
    recorded_processes_are_active || active_status=$?
    if [ "$active_status" -eq 0 ]; then
        echo "❌ Owned process tree rooted at PID $pid did not stop (active PIDs: $(report_active_recorded_processes))" >&2
        return 1
    fi
    if [ "$active_status" -gt 1 ]; then
        echo "❌ Could not verify whether the owned process tree rooted at PID $pid stopped (process inspection exited $active_status)" >&2
        return "$active_status"
    fi
    wait "$pid" 2>/dev/null || true
    return 0
}
