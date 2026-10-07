# CI and local review

The automated validation battery uses code tests. Browser test suites, native
browser comparison assertions and automatic frame-work/constrained-client gates
are removed. Unit tests and complete server/entity integration run locally before
publication; PR CI independently validates the integration inventory.

## Required PR checks

`static-checks`, `runner-contracts` and `integration-tests` start concurrently.
Static checks cover lint policy, formatting, unused code, Markdown, YAML, Actions,
TypeScript, benchmark types, Wiki source review and the production build.
Runner contracts exercise owned process startup, admission, ports and cleanup.
Integration runs every test in `tests/integration/server/` and
`tests/integration/entities/` through the repository runner.

The required `ci` aggregate succeeds only when all three lanes succeed. Failed,
cancelled, skipped or absent required evidence cannot pass. Each lane performs
the canonical range secrets scan before considering reusable exact-tree proof.
Post-merge CI reuses successful PR evidence only for the identical Git tree and
matching lane. Missing proof reruns that lane; manual dispatch validates normally.
Dependabot keeps its explicit manual-drain invocation gate.

## Local review

Run from `/Users/johnsolly/code/GeoRoids` or the absolute feature-worktree path.

1. Run affected deterministic unit scenarios or code integration through
   `scripts/test-runner.sh`, and independently review the change and evidence.
2. Fix findings and repeat affected checks. Keep one isolated Vitest worker with
   no file parallelism or concurrent test sequences within each run.
3. Run `npm run gate` after final edits and before publication through `/ship`.
   It owns static checks, runner contracts, all units, build and `test:review`.
4. `npm run test:review` runs the complete server/entity integration inventory.
   A partial selection or a successful hosted lane cannot replace the local gate.

Different worktrees can run unit, runner-contract and integration code checks
concurrently. Each checkout excludes overlapping validation because builds,
services and artifacts belong to it. The integration runner selects unused ports,
owns its services, defaults to a 1200-second execution deadline and stops only its
owned processes. Cleanup failures retain the ownership barrier and fail the run.
Manual browser benchmarking and frame measurement still use the common-Git
heavyweight queue; their measurements are outside the automatic gate.

Retain the printed review/session artifact directories and actual exit results.
Do not commit generated logs or reports. Report removed coverage and any unrun or
skipped checks explicitly. Coverage is available through `npm run test:coverage`
and the manual Coverage report workflow, without a percentage merge threshold.

## Production verification

Production smoke uses HTTP and a genuine current-protocol WebSocket pilot. It
checks the client release manifest, module entry identity and declared bundle
availability, exact server release admission, current snapshots, acknowledged
movement, an accepted shot and healthy world persistence. It does not launch a
browser or certify rendering, keyboard/touch controls, graphics or audio.
The local smoke scenario contracts use controlled clocks and transports with the
production protocol encoder/decoder. Follow the exact release/request receipt;
a skipped, failed, missing or timed-out smoke remains unverified.

This test-tooling removal changes no gameplay behavior, controls, assets or Wiki
player instructions. Wiki media generation remains a manual browser tool.

## Exact validation receipts

A complete receipt is reusable only when source content, modes and symlinks, relevant runtime inputs, installed dependencies and tool identities, stage definitions, retained artifact hashes and final cleanup evidence still match. Receipt reuse requires the current staged candidate to match the checked working tree, including manual invocations; divergent partial staging cannot inherit its proof. Missing, malformed, failed, cancelled or stale receipts require fresh validation. A fleet documentation fast-path result is never a complete-battery receipt. Build commit identity, npm configuration and consumed symlink targets also enter the receipt. Caller environment differences can conservatively require another run, including native commits versus npm invocations. Internal installed-directory aliases are covered through their canonical payload; external directory links are unsupported. Local receipts do not replace CI or production verification.

A previous successful graph witness can avoid Knip and ts-prune for proven numeric or boolean constant-data literal changes with unchanged module references, imports, exports, declarations, object shape and dependencies. String literals, unknown edits and mixed changes run graph checks. Changed source still runs unit, build and server/entity integration checks; gameplay evidence never transfers across changed literal values.
