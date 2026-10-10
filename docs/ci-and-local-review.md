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

Testing commands, deterministic setup, runner ownership, cleanup and evidence
reporting live in [tests/AGENTS.md](../tests/AGENTS.md). Publication through `/ship`
requires the complete `npm run gate`; a partial selection or hosted lane cannot
replace it. Coverage reporting has no percentage merge threshold.

## Production verification

Production smoke uses HTTP and a genuine current-protocol WebSocket pilot. It
checks gameplay module reachability and declared bundle availability, current
protocol admission and snapshots, acknowledged
movement, an accepted shot and healthy world persistence. It does not launch a
browser or certify rendering, keyboard/touch controls, graphics or audio.
The local smoke scenario contracts use controlled clocks and transports with the
production protocol encoder/decoder. Host deployment status establishes the
release; descriptive metadata and bundle text do not gate verification. Follow
the scenario checkout/request receipt;
a skipped, failed, missing or timed-out smoke remains unverified.

This test-tooling removal changes no gameplay behavior, controls, assets or Wiki
player instructions. Wiki media generation remains a manual browser tool.

## Exact validation receipts

A complete receipt is reusable only when source content, modes and symlinks, installed bytes, selected tool bytes, relevant execution inputs, stage definitions, retained artifact hashes and cleanup evidence match. The staged candidate must match the checked working tree; partial staging cannot inherit proof. Missing, failed, cancelled, malformed or damaged evidence requires fresh checks. Local receipts do not replace CI or production verification.

Manual and hook launches resolve their execution environment through the same built-in npm lifecycle before the code battery. Environment resolution uses the same ownership supervisor, with captured values kept in memory and verified descendant cleanup. The gate remains the authenticated direct child of its supervisor. The actual execution environment removes duplicate PATH entries, Git's hook-added helper prefix and three host REPL-only metadata variables. Other PATH entries keep their order; selected tools, npm configuration, hosted release SHAs, environment files and consumed symlink targets stay fingerprinted. Unknown execution controls still disable reuse. No fingerprint-only exception substitutes for this actual environment.

A commit of already verified source changes the release stamp. If a fully validated complete candidate has identical source, installation and runtime, only the build runs again for the new HEAD. Code stages retain their original artifacts and a hashed complete donor receipt; output labels them reused. The build remains HEAD-bound, and corrupt provenance, changed inputs, failed builds or unproven cleanup cannot certify the new HEAD. Non-build validation must operate on the checked source and controlled fixtures, not the checkout's commit label. Literal-only graph proofs are not donors for this HEAD transition.

A newer code attempt invalidates older passes for the same source, installation and runtime before checks start. Failed or interrupted attempts retain their diagnostics and require fresh code validation; an unrelated attempt cannot erase that barrier. Build-only failures retain the code proof but always rebuild on retry.

Caller overrides and unsupported external installed-directory links remain conservative reuse boundaries. A fleet documentation fast path is never a complete-battery receipt.
