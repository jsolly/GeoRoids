# CI and local review

PR CI targets less than five minutes from workflow creation to completion.
Heavy tests run in the local review/fix loop and the full gate before push.

## Required PR checks

`static-checks`, `runner-contracts`, and `behavioral-smoke` start concurrently.
Static checks cover lint policy, formatting, unused code, Markdown, YAML, Actions,
TypeScript, benchmark types, Wiki source review, and the production build.
Runner contracts run the unchanged test-runner and dev-server commands once.
The smoke runs these scenarios through the serialized integration runner:

- Desktop boot, movement, and authoritative firing.
- Density changes and mobile viewport/touch controls.
- Current-protocol reconnect recovery.

The final required `ci` job succeeds only when all three lanes succeed. Failed,
cancelled, and skipped dependencies fail the aggregate. Each substantive lane has
a four-minute timeout; timing a successful real run establishes the five-minute
target, not the timeout setting. Setup, browser installation, artifacts, and the
aggregate are included in the measurement. GitHub runner queues can still delay a run.

Each lane runs the canonical range secrets scan before considering reusable proof.
Post-merge runs reuse successful PR lane evidence only for an identical Git tree.
Each proof is scoped to its job and exact tree; one lane cannot certify another.
Missing evidence reruns that lane, and manual dispatch runs all three normally.
Dependabot retains
its explicit manual-drain invocation gate. No automatic dependency checks or
merges are added by this change.

## Local review loop

Run commands from `/Users/johnsolly/code/GeoRoids`, or the absolute path of the
feature worktree being reviewed. Install the pinned browsers once per Playwright
upgrade with `npx --no-install playwright install chromium webkit`. On Linux,
include `--with-deps` to install their system libraries.

1. Add or update regression tests for the change and run the affected scenarios
   through `scripts/test-runner.sh`. Review the code and test evidence independently.
2. Fix findings and repeat affected checks. Keep each integration child serialized;
   use the owned six-shard coordinator for full runs, never raw Vitest or extra workers.
3. Run `npm run gate` after the final changes and before pushing through `/ship`.
   This runs all static checks, the full unit suite, build, and `npm run test:review`.
4. `test:review` runs **all** integration tests in six isolated serial shards with
   at most three active children, the deterministic frame-work budget,
   then the production-client traversal scenario at 4× CPU slowdown with network
   delay and combat at native CPU speed. Both use a portrait touch viewport at DPR 3.
   Failures stop the gate. Fix and repeat; a green CI smoke does not replace this gate.

The pre-commit hook owns the complete static/unit/build and integration/performance battery. `npm run gate` uses the same entry even with an empty index, with the fleet documentation fast path disabled. For focused iteration, `npm run test:review` runs only the heavy
integration/performance portion. Standalone integration runs retain their existing
20-minute deadline, process ownership, and cleanup. Full coordinated runs require
less than 600 seconds including discovery and cleanup; 300 seconds remains a future performance target; see [isolated shards](integration-shards.md). Choose unused ports with
`GEOROIDS_TEST_VITE_PORT` and `GEOROIDS_TEST_SERVER_PORT` when another dev session
owns the defaults; the repository-wide lock still allows only one coordinator or standalone integration run.

Each heavy run keeps console output, client/server logs, screenshots, benchmark
JSON, and its exit status in a unique ignored `.performance/review/run.*` directory.
The command prints that directory on start and completion. Integration receipts
point to the separate retained directory for all six isolated children. Retain both for review;
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

## Production firing evidence

The production smoke fires through the real page's Space key and observes the
outgoing `shoot` request on the admitted gameplay socket. It requires a matching
`shotAcknowledged` with a nonempty projectile ID on that same socket for the
joined local player. A null acknowledgement is a rejected shot and cannot pass.
Requests and acknowledgements observed before the firing step cannot pass either.

An accepted bolt can hit an asteroid immediately, before the next snapshot.
Firing verification therefore uses the server's acknowledgement, which precedes
immediate hit resolution, rather than requiring the bolt to survive in a snapshot.
Release identity, world health, decoded snapshots, movement and browser diagnostic
checks still apply. This changes verification only; gameplay and Wiki instructions
are unchanged.

The optional manually dispatched [native repeatability sample](integration-repeatability.md)
runs 20 focused audio lifecycle repetitions and three full integration suites on
both native Ubuntu architectures at one pinned SHA. It retains every failed attempt
and never substitutes retries for a passing sample.

## Exact validation receipts

A complete receipt is reusable only when source content, modes and symlinks, relevant runtime inputs, installed dependencies and tool identities, stage definitions, retained artifact hashes and final cleanup evidence still match. Receipt reuse requires the current staged candidate to match the checked working tree, including manual invocations; divergent partial staging cannot inherit its proof. Missing, malformed, failed, cancelled or stale receipts require fresh validation. A fleet documentation fast-path result is never a complete-battery receipt. Build commit identity, npm configuration and consumed symlink targets also enter the receipt. Caller environment differences can conservatively require another run, including native commits versus npm invocations. Internal installed-directory aliases are covered through their canonical payload; external directory links are unsupported. Local receipts do not replace CI or production verification.

A previous successful graph witness can avoid Knip and ts-prune for proven numeric or boolean constant-data literal changes with unchanged module references, imports, exports, declarations, object shape and dependencies. String literals, unknown edits and mixed changes run graph checks. Changed source still runs unit, build, integration and performance checks; gameplay evidence never transfers across changed literal values.
