# CI and local review

PR CI targets less than five minutes from workflow creation to completion.
Heavy tests run in the local review/fix loop and the full gate before push.

## Required PR checks

`static-checks` and `behavioral-smoke` start concurrently. Static checks cover
lint policy, formatting, unused code, Markdown, YAML, Actions, runner/dev process
contracts, TypeScript, benchmark types, Wiki source review, and the production
build. The smoke runs these scenarios through the serialized integration runner:

- Desktop boot, movement, and authoritative firing.
- Density changes and mobile viewport/touch controls.
- Current-protocol reconnect recovery.

The final required `ci` job succeeds only when both lanes succeed. Failed,
cancelled, and skipped dependencies fail the aggregate. Each substantive lane has
a four-minute timeout; timing a successful real run establishes the five-minute
target, not the timeout setting. Setup, browser installation, artifacts, and the
aggregate are included in the measurement. GitHub runner queues can still delay a run.

Post-merge runs reuse successful PR lane evidence only for an identical Git tree.
Missing evidence and manual dispatch run both checks normally. Dependabot retains
its explicit manual-drain invocation gate. No automatic dependency checks or
merges are added by this change.

## Local review loop

Run commands from `/Users/johnsolly/code/GeoRoids`, or the absolute path of the
feature worktree being reviewed. Install the pinned browsers once per Playwright
upgrade with `npx --no-install playwright install chromium webkit`. On Linux,
include `--with-deps` to install their system libraries.

1. Add or update regression tests for the change and run the affected scenarios
   through `scripts/test-runner.sh`. Review the code and test evidence independently.
2. Fix findings and repeat affected checks. Keep integration tests serialized;
   never use raw Vitest or extra workers to shorten them.
3. Run `npm run gate` after the final changes and before pushing through `/ship`.
   This runs all static checks, the full unit suite, build, and `npm run test:review`.
4. `test:review` runs **all** integration tests, the deterministic frame-work budget,
   then the production-client traversal scenario at 4× CPU slowdown with network
   delay and combat at native CPU speed. Both use a portrait touch viewport at DPR 3.
   Failures stop the gate. Fix and repeat; a green CI smoke does not replace this gate.

The pre-commit hook retains its static/unit/build checks. `npm run gate` forces
those checks even with an empty index, then runs the heavy review checks. For focused iteration, `npm run test:review` runs only the heavy
integration/performance portion. The full integration runner retains its existing
20-minute deadline, process ownership, and cleanup. Choose unused ports with
`GEOROIDS_TEST_VITE_PORT` and `GEOROIDS_TEST_SERVER_PORT` when another dev session
owns the defaults; the repository-wide lock still allows only one integration run.

Each heavy run keeps console output, client/server logs, screenshots, benchmark
JSON, and its exit status in a unique ignored `.performance/review/run.*` directory.
The command prints that directory on start and completion. Retain it for review;
do not commit generated test artifacts. Report skipped tests explicitly, including
any pre-existing skips; never describe them as passes.

Coverage remains available through `npm run test:coverage` and the manually
dispatched Coverage report workflow. It is separate from performance measurement
and has no coverage-percentage merge gate. Weekly/manual full integration remains
an additional hosted backstop, rather than the owner of pre-push regression checks.

## Timing evidence

Before this split, [PR run 35949387113](https://github.com/jsolly/GeoRoids/actions/runs/35949387113)
took 13 minutes 8 seconds. Behavioral checks took 6 minutes 10 seconds and blocked
the 6-minute 51-second validation job. Its 306 unit-test files alone took 327.67 seconds.
The reduced smoke passed locally with five tests in 15.61 seconds, excluding setup.
For hosted verification, measure from the Actions run creation time through the
last job completion and link the successful run in the PR validation receipt.

No game behavior, controls, or Wiki content changes are part of this workflow split.
