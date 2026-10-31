# CI and local review

The automated validation battery uses code tests. Browser test suites, native
browser comparison assertions and automatic frame-work/constrained-client gates
are removed. Unit tests and complete server integration run locally before
publication; PR CI independently validates the integration inventory.

## Required PR checks

`static-checks`, `runner-contracts`, `actions-contracts`, `integration-tests` and
`wiki-media` start concurrently.
Static checks cover lint policy, formatting, unused code, Markdown, YAML,
TypeScript, benchmark types, Wiki source review and the production build.
Runner contracts exercise owned process startup, admission, ports and cleanup.
Actions contracts run `check:actions`: the CI, gate, review-receipt and smoke
contract suites plus actionlint. Its gate contract suite is the longest single
check, so it runs beside static checks instead of inside them.
Integration runs every test in `tests/integration/server/` through the repository runner. Wiki media verifies
the committed demonstration baseline on `ubuntu-24.04`, the x64 platform that owns
it, and uploads a regenerated candidate when it is stale; the other lanes run on
arm64 ([Wiki maintenance](wiki-maintenance.md#generate-or-verify-gifs)).

The required `ci` aggregate succeeds only when all five lanes succeed. Failed,
cancelled, skipped or absent required evidence cannot pass. Each lane performs
the range secrets scan before considering reusable exact-tree proof. The lanes'
copy selects the pinned gitleaks archive for its runner architecture, because the
media lane runs on x64; the `ci` job keeps the canonical arm64 step.
Post-merge CI reuses successful PR evidence only for the identical Git tree and
matching lane. Missing proof reruns that lane; manual dispatch validates normally.
Dependabot keeps its explicit manual-drain invocation gate.

## Local review

Testing commands, deterministic setup, runner ownership, cleanup and evidence
reporting live in [tests/AGENTS.md](../tests/AGENTS.md). Publication
requires the complete `npm run gate`; a partial selection or hosted lane cannot
replace it. `scripts/gate-receipt.mjs` `STAGES` is the source of truth: repository hook trust/bootstrap fixtures, lint policy, lint, Knip, ts-prune, class members, Markdown, YAML, Actions, runner and dev-server contracts, TypeScript, Astro/Svelte diagnostics, frontend formatting, benchmark types, the complete unit/component suite, build, and complete server integration. Coverage reporting has no percentage merge threshold.

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
a skipped, failed, missing or timed-out smoke remains unverified. Unexpected application and transport errors reach the job log once with safe causes; parser diagnostics omit response and socket content. Public receipt and gameplay-artifact error strings remain bounded.

Wiki media generation uses node-canvas and Python with the pinned requirements in `scripts/wiki-media-requirements.txt`; it needs no browser.

## Exact validation receipts

A complete receipt is reusable only when source content, modes and symlinks, installed bytes, selected tool bytes, relevant execution inputs, stage definitions, retained artifact hashes and cleanup evidence match. The staged candidate must match the checked working tree; partial staging cannot inherit proof. Missing, failed, cancelled, malformed or damaged evidence requires fresh checks. Local receipts do not replace CI or production verification.

The gate executes the selected npm entry normally, including tool-manager shell
wrappers. Its actual lifecycle identifies the npm CLI and Node interpreter behind
that entry; their resolved paths and bytes enter the runtime fingerprint alongside
the wrapper. Replacing the underlying CLI invalidates prior validation evidence.

Manual and hook launches resolve their execution environment through the same built-in npm lifecycle before the code battery. Environment resolution uses the same ownership supervisor, with captured values kept in memory and verified descendant cleanup. The gate remains the authenticated direct child of its supervisor. The actual execution environment removes duplicate PATH entries, Git's hook-added helper prefix, the host module path `NODE_PATH` (so it cannot add host module directories to resolution) and three host REPL-only metadata variables. Other PATH entries keep their order; selected tools, npm configuration, hosted release SHAs, environment files and consumed symlink targets stay fingerprinted. Host-injected TLS trust and npm proxy settings (`NODE_USE_SYSTEM_CA`, `NODE_EXTRA_CA_CERTS`, `NPM_CONFIG_USERCONFIG`, `npm_config_https_proxy`) stay in execution and are digested by value, and the selected npm user config also by bytes; the extra-CA bundle's bytes are not, because the proxy rotates it and no validation stage uses Node TLS. Unknown execution controls still disable reuse. No fingerprint-only exception substitutes for this actual environment.

A commit of already verified source changes the release stamp. If a fully validated complete candidate has identical source, installation and runtime, only the build runs again for the new HEAD. Code stages retain their original artifacts and a hashed complete donor receipt; output labels them reused. The build remains HEAD-bound, and corrupt provenance, changed inputs, failed builds or unproven cleanup cannot certify the new HEAD. Non-build validation must operate on the checked source and controlled fixtures, not the checkout's commit label. Literal-only graph proofs are not donors for this HEAD transition.

A newer code attempt invalidates older passes for the same source, installation and runtime before checks start. Failed or interrupted attempts retain their diagnostics and require fresh code validation; an unrelated attempt cannot erase that barrier. Build-only failures retain the code proof but always rebuild on retry.

Caller overrides and unsupported external installed-directory links remain conservative reuse boundaries. A fleet documentation fast path is never a complete-battery receipt.
