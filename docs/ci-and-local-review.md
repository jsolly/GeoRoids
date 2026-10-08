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
concurrently. Each checkout excludes overlapping validation because builds and
artifacts belong to it. The integration runner owns an isolated Vitest worker and
per-run artifacts, defaults to a 1200-second execution deadline and stops only its
owned processes. Individual socket scenarios create and close port-zero loopback
servers; the code runner starts no Vite/server pair. Cleanup failures retain the ownership barrier and fail the run.
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

A complete receipt is reusable only when source content, modes and symlinks, installed bytes, selected tool bytes, relevant execution inputs, stage definitions, retained artifact hashes and cleanup evidence match. The staged candidate must match the checked working tree; partial staging cannot inherit proof. Missing, failed, cancelled, malformed or damaged evidence requires fresh checks. Local receipts do not replace CI or production verification.

Manual and hook launches resolve their execution environment through the same built-in npm lifecycle before the code battery. Environment resolution uses the same ownership supervisor, with captured values kept in memory and verified descendant cleanup. The gate remains the authenticated direct child of its supervisor. The actual execution environment removes duplicate PATH entries, Git's hook-added helper prefix and three host REPL-only metadata variables. Other PATH entries keep their order; selected tools, npm configuration, hosted release SHAs, environment files and consumed symlink targets stay fingerprinted. Unknown execution controls still disable reuse. No fingerprint-only exception substitutes for this actual environment.

A commit of already verified source changes the release stamp. If a fully validated complete candidate has identical source, installation and runtime, only the build runs again for the new HEAD. Code stages retain their original artifacts and a hashed complete donor receipt; output labels them reused. The build remains HEAD-bound, and corrupt provenance, changed inputs, failed builds or unproven cleanup cannot certify the new HEAD. Non-build validation must operate on the checked source and controlled fixtures, not the checkout's commit label. Literal-only graph proofs are not donors for this HEAD transition.

A newer code attempt invalidates older passes for the same source, installation and runtime before checks start. Failed or interrupted attempts retain their diagnostics and require fresh code validation; an unrelated attempt cannot erase that barrier. Build-only failures retain the code proof but always rebuild on retry.

Caller overrides and unsupported external installed-directory links remain conservative reuse boundaries. A fleet documentation fast path is never a complete-battery receipt.
