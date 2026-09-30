# Backlog implementation plan

The approved sequence contains 16 PRs. Status describes implementation progress,
not Todoist completion. Each PR starts from fresh `origin/main`, ships through
`/ship` semantic review and the full local gate, and merges by squash when CI is
green. Verify exact Vercel and Railway releases as applicable, then complete the
matching production smoke. Never infer deployment success from CI alone.

Gameplay acceptance covers desktop and touch with two clients, authoritative
rules, prediction, snapshots, reconnect, restart, locality and affected Wiki
content. Preserve existing shared state and the existing world. Mark completion
only after fresh evidence covers the PR's acceptance criteria.

## Sequence and acceptance

| PR | Work and required proof | Status | Todoist IDs |
| --- | --- | --- | --- |
| 1 | Reconcile verified completions and engineering decisions. Keep relative imports, no barrels and Canvas2D; verify existing regeneration and survey sharing. Distinguish historical performance from physical-phone proof. | Shipped [#737](https://github.com/jsolly/GeoRoids/pull/737) | Alias `6hcHJJpqRp2MmcMv`; GPU `6hcHJJxRJgM4GwWM`; regeneration `6hfGfxp2c6wf2gmM`; survey `6hfFGqgFPxC28f9v`; archived work `6hRVg8qpghM6Qv22` |
| 2 | Fix fixture determinism and retain actionable failure evidence for #715 and #716. Prove failures expose the cause without retries or weaker assertions. | Shipped [#738](https://github.com/jsolly/GeoRoids/pull/738), `e0ef52be` | Triage `6hfFQfq4PP367Vxv`; harness parent `6hfFQcvww7gHj4Mv`; human schedule `6hf8pMC4JVjgvgQv` |
| 3 | Fix WebKit audio and obtain cross-architecture proof for #714 and #717. Run 20 focused repetitions and three full suites on native ARM and x64. | In progress in an isolated checkout | Same triage, harness parent and human schedule as PR 2 |
| 4 | Prove authoritative firing in production. A correlated non-null `shotAcknowledged` is sufficient even if a collision consumes the bolt before a snapshot. Reject missing, null, wrong or stale acknowledgements; malformed snapshots still fail. | Shipped [#739](https://github.com/jsolly/GeoRoids/pull/739) | Projectile `6hfP8334Q638373M` |
| 5 | Run six isolated integration shards three times, each run under 300 seconds. Preserve isolation and failure evidence. | Planned | Shards `6hcHJM3WrR7Hh9CM` |
| 6 | Normalize full pre-commit checks, preserving the existing fleet documentation fast path exception, and scope Wiki source review to affected behavior. | Planned | Gate `6hcHJJjhGW7p6rFM`; Wiki `6hcHJJmG74wPCghv` |
| 7 | Audit targeted dependency injection and indexes. Use measured ownership and query needs to choose changes. | Planned | Singleton `6hcHJJrWqGh6qFqM`; index `6hfGCG7hM6rmgCfv` |
| 8 | Improve furnace travel and delivery feedback, including pinching, drop-off and shortage feedback. | Planned | Pinch `6hfFVMfQvxvm7JHv`; drop-off `6hfG7J5m99CC75mM`; shortage `6hfGfjj459h5v7Wv` |
| 9 | Add cargo shielding and hauling pressure. Apply immunity first, then eject recoverable loot at 10 cargo points per HP. Hull health falls only for residual damage after cargo reaches zero. Cargo speed scales from 1 empty to 0.7 full. Reduce loot magnetic pull and give spills outward motion beyond immediate pickup reach; tune against current values during implementation. Prove physical conservation of recoverable hit spills, concurrent pickup, identity and expiry, no loot consumption for full-cargo ships, retention of partial remainders and remaining cargo dropping once on death. Use a bounded temporary own-spill recollection lockout only if the spatial kick and reduced pull still allow automatic overlap to negate the hit. | Planned | Cargo `6hfGfwppj5j2hPmv`; roles `6hfFGqVW7vrcCWhv` |
| 10 | Add travelling tow/probe behavior at speed 1200. Preserve solo Hauler Tow Cable access to hives. Misses retract; each attempt incurs cooldown, enforced by the authoritative server. | Planned | Tow `6hfG7XPr4P73WcwM` |
| 11 | Add storage and encounter foundations plus an additive migration tool. Keep activation disabled until John applies the reviewed production database migration. | Planned | Foundation for cooperative parent `6hfFGm8JJVJ5JRmM` |
| 12 | Add crew signals and rescue. Downed state lasts 30 seconds; rescue range is 100, revive takes three seconds and restores 35% health. Preserve shared surveys. | Planned | Pings `6hfFGqhXJMf6Pc7v`; downed `6hfFGqGxgCjxFmxM`; survey `6hfFGqgFPxC28f9v` |
| 13 | Add queens with 500 HP, births every eight seconds and at most six owned spiders. Set two initial sacs and three expanded sacs, each with 50 HP and 20-second timing. Queen death permanently removes all owned spiders and its marker. | Planned | Queen `6hfFGqVRXR6496gM`; sacs `6hfFGqRWCgjQH9mv` |
| 14 | Add physical frontier restoration worth 9600, supplied from inward settlements, with a permanent 1200 atlas. Restoration is monotonic; cleared ruins have no furnace counterattacks. | Planned | Frontier `6hfFGqPVvGv8HPCv`; supply `6hfFGqMc8w3vG7Wv` |
| 15 | Add Town Square Deep Scanner requiring 10000 physical ore. Unlock the 20000–57500 frontier; initial frontier is 11000–20000. Activate the community frontier in the existing world. | Planned | Mega project `6hfFGqXQ5RvvhHrM` |
| 16 | Add UTC half-hour hazards. Warn at :25–:30 and :55–:00; active windows are :00–:03 and :30–:33. Affect ships and cargo, with no furnace damage. Reserve 12 swarm slots within 48 total; prove deadline cleanup. | Planned | Hazards `6hfFGqW8FMr7hmrM` |

## Locked decisions and human hand-off

Cargo ejects as recoverable loot before hull damage, at 10 points per HP. Apply
immunity first; hull health falls only for residual damage after cargo reaches
zero. Reduce loot magnetic pull and eject spills outward beyond immediate pickup
reach. Tune against current values during implementation, preserving physical
conservation, concurrent pickup, identity and expiry. Add a bounded temporary
own-spill recollection lockout only if the spatial kick and reduced pull still
allow automatic overlap to negate the hit. Remaining cargo drops once on death, and full-cargo
ships cannot consume loot. A solo Hauler uses Tow Cable
for hives. Queens keep birthing until death; death permanently clears their owned
spiders and marker. Ruin restoration only advances and never triggers furnace
counterattacks. The counterattack task `6hfFGqPMFqCMJfpM` is explicitly rejected
and already closed.

Hazards follow UTC half-hour boundaries, warn for five minutes and remain active
for three minutes. They affect ships and cargo, without furnace damage. Community frontier activation
uses the existing world rather than resetting it.

John alone applies the additive production database migration between foundation
and activation. PR 11 must provide the reviewed migration and exact hand-off
command; activation waits for its successful application. Agents do not perform
production database writes. Native ARM/x64 and physical-device scheduling remain
on the human schedule task where access requires John.

The engineering parent `6hcHJHRRJ3hVchRM` and cooperative parent
`6hfFGm8JJVJ5JRmM` close only when their descendants are resolved. Shared parent
IDs in the table do not imply the parent is complete. Root coordinates Todoist
updates and shipping; this document introduces no automatic schedule.

## Evidence ledger

PR 1 landed as [#737](https://github.com/jsolly/GeoRoids/pull/737), commit
`cc66b9fc`. The fleet docs-only branch gate passed secrets/Markdown and
1713 unit tests across 308 files; build and full integration were skipped under
that exception. Three focused integration tests passed separately. Semantic
review and CI passed. Root verified the exact
Vercel release and healthy Railway worker persistence with zero loop stalls;
[production smoke 36715588681](https://github.com/jsolly/GeoRoids/actions/runs/36715588681)
succeeded with request `6759419491` and a downloaded exact-release receipt.
The four PR 1 reconciliation tasks are closed; this does not close later PRs.

PR 2 development evidence on native macOS ARM64, 2026-09-30:

- Before changes, the two focused files passed all four original cases in 26.16
  seconds at `cc66b9fc`. Neither historical issue failure was reproduced, and no
  historical root cause is claimed.
- The changed focused browser files passed 11 scenarios in 30.71 seconds,
  including both round trips, independently arranged store/Wiki/layout checks,
  two-pilot belt discovery/mining and separate crawler windup checks.
- Endpoint, reset, evidence and browser-cleanup contracts passed 35 tests across
  four files in 3.68 seconds; a separate evidence-I/O contract also passed.
  TypeScript, benchmark types, Biome, Knip, ts-prune, Markdown and build passed.
  Build retained its existing large-chunk warning.
- Stage JSON and screenshots remain under the ignored browser screenshots
  directory; command output is retained in `/tmp/georoids-pr2-before.log`,
  `/tmp/georoids-pr2-focused.log` and `/tmp/georoids-pr2-contracts.log`.

These are working-tree Chromium/touch-emulation checks. Historical-revision,
native x64 and clean-commit repeatability proof remain unrun; physical-phone
coverage is not claimed. The suite-order batch passed 16 tests across five files in 47.35 seconds,
including reset/readiness contracts and intentionally lethal asteroid/protection
scenarios (`/tmp/georoids-pr2-order-after-fix.log`). The first order run failed
because the new metadata reader used a non-file Vitest URL; its failure output
is retained in `/tmp/georoids-pr2-order.log`, and the reader was corrected. The
final seeded belt run passed four browser cases in 7.36 seconds; the explicit
seed-42 endpoint contracts passed 13 tests in 3.08 seconds. Their first seeded
run exposed a new contract test capturing its world baseline before the second
pilot joined; moving the baseline after both joins preserved the full-state
assertion (`/tmp/georoids-pr2-seeded-contract-after-fix.log`). The final full
gate, semantic review, CI and release-specific verification remain pending for
PR 2.
The archived-work record `6hRVg8qpghM6Qv22` is closed. Root verified its children
with a fresh receipt; it records completed historical work and does not close
any planned PR above.

PR 2 review fixes retain either available server/client observation when the other
capture fails, retain bounded nested teardown errors and causes, and reject a
controlled placement superseded between acknowledgement and final alignment.
The new unit regressions passed nine tests across two files; the final affected
unit batch passed 26 tests across three files. The first regression
run had two assertion-shape failures because the expected receipt omitted its
second failure-capture stage; both retained stages are now asserted. Logs are
`/tmp/georoids-pr2-review-fixes.log` and
`/tmp/georoids-pr2-review-fixes-after-test-fix.log`. No integration runner was
started during these review fixes; refreshed gameplay proof and the full gate
remain pending root's runner allocation.

The shared-field rendering scenario now arranges identified stationary and moving
rocks with two safe pilots in a distant shared sector. Both clients observe the
identified drifter; both desktop and touch contexts retain bitmap silhouette,
projection and viewport assertions. Native drift-mix statistics remain covered
without changing their natural-world fixture. Endpoint and density contracts
passed 26 tests across two files in 3.68 seconds. An initial focused run failed
because the old bitmap helper assumed DPR 1; the new touch context has DPR 2.
CSS viewport, backing dimensions and executed transforms now have independent
assertions. The corrected shared-field scenario passed in 3.82 seconds. Failed
output and evidence remain in `/tmp/georoids-pr2-shared-field-focused.log` and
the ignored screenshot directory; corrected output is
`/tmp/georoids-pr2-shared-field-dpr-fixed.log`.

The final affected browser batch passed all 12 cases across three files in
34.05 seconds (`/tmp/georoids-pr2-shared-field-final-focused.log`). Shared-field
arrangement metadata now returns both stable rock IDs; fixture receipts retain
their authoritative positions and velocities, and the browser checks the moving
ID advanced on the server before pausing rendering. The final metadata addition
passed 14 endpoint contracts in 3.16 seconds and the shared-field browser case
in 4.20 seconds (`/tmp/georoids-pr2-shared-metadata-unit.log` and
`/tmp/georoids-pr2-shared-metadata-focused.log`); TypeScript passed. These remain
native arm64 dirty-tree receipts, not historical failure or clean-release proof.
The full gate and shipping remain root-owned and pending.

PR 2 round-two cleanup repair routes the shared-field body and all restoration
and observer-disposal operations through one failure-preserving helper. A body
failure cannot bypass restoration diagnostics; simultaneous errors are retained
in one aggregate, and a single error keeps its original identity. The actual
helper contract and evidence tests passed eight tests across two files in
422 milliseconds; the focused shared-field browser case passed in 3.55 seconds.
Logs are `/tmp/georoids-pr2-round2-unit-final.log` and
`/tmp/georoids-pr2-round2-focused.log`. An initial new-test syntax error from
removing the outer async callback was corrected; its failed unit/type outputs
remain at `/tmp/georoids-pr2-round2-unit.log` and
`/tmp/georoids-pr2-round2-ts.log`. Final TypeScript passed; full gate remains
pending root.

The first complete PR 2 gate attempt failed its integration lane: 205 of 207
tests passed across 88 passing and two failing files (90 files total). Frame-work
and constrained-client checks did not run because integration failed. Preserve
`/tmp/georoids-pr2-final-gate.log` and `.performance/review/run.L1wKy1`.
The reset test still expected the former exact error body, omitting the new
`socket-close-failed` reason; its exact response assertion now includes that
classification and retains every close, world-preservation and causal-log check.
The desktop economy pilot died from an asteroid while sequential default boot
waits expired spawn protection; cargo arrangement correctly rejected the dead
crew before its later respawn. Both economy pilots now arrange immediately after
joining without a combat-readiness wait, enforce both fixture epochs, and use
controlled town placement. All bank, cargo, shared-level, placeholder-store and
desktop/touch assertions and the 90-second timeout remain. The affected two-file
runner passed six tests in 5.41 seconds; affected unit contracts passed 20 tests
across three files in 3.38 seconds. Biome passed; the initial TypeScript pass report was incorrect, as corrected
below. Logs are
`/tmp/georoids-pr2-gate-fixes-focused.log` and
`/tmp/georoids-pr2-gate-fixes-unit.log`. The full gate must run again on the fixed
tree; the failed first attempt does not prove its downstream checks.

The second full-gate attempt stopped at TypeScript with four TS2345 errors in
the economy epoch lookups; unit, build and integration checks did not run. The
prior final-TypeScript pass report was wrong: the shell sequence continued after
tsc failed and its later successful lint command masked that status. The failed
output remains in `/tmp/georoids-pr2-gate-fixes-ts.log` and
`/tmp/georoids-pr2-final-gate-2.log`. Named IDs read from each actual player now
construct the crew array and index the epoch maps directly, avoiding possibly
undefined array indices without casts or non-null assertions. Runtime focused
proof remains the earlier six passing cases; this identifier-only correction
requires fresh type and static checks before the third gate attempt.
The corrected TypeScript command exited zero independently, as did Biome,
Markdown and diff checks; outputs are retained in
`/tmp/georoids-pr2-gate-fixes-ts-corrected.log`,
`/tmp/georoids-pr2-gate-fixes-lint-corrected.log` and
`/tmp/georoids-pr2-gate-fixes-md-corrected.log`. No integration runner was started
for this identifier-only correction; the third full gate remains root-owned.

The third complete PR 2 gate failed integration again: 205 of 207 tests passed
across 88 passing and two failing files in 783.87 seconds. The pinball 1280 case
and WebKit landscape title/flight audio case failed; frame-work and
constrained-client checks did not run after that integration failure. Retain
`/tmp/georoids-pr2-final-gate-3.log` and `.performance/review/run.ViReRI`.
The audio failure was exactly `afterInput.thrusting` at the former line 227,
not the context-state mismatch from #714. Every preceding audio loop/context,
player/session/socket and preference assertion completed. The same pilot died
from an asteroid at 14:25:23.483 UTC, the client observed death at .486, and
respawn arrived at .790 immediately before the failure. Explosion intentionally
sets thrusting false. The old scenario expired spawn protection and left ambient
asteroids active while it checked UI and native audio. Its success receipt and
Wiki screenshot were stale from an earlier attempt and do not prove this run.

The audio scenario now arranges the existing empty authoritative crew scene
immediately after joining, indexes its motion epoch by the actual player ID,
and waits for that exact live client/server epoch before continuing. The fixture
rejects a dead pilot rather than resurrecting it. A zero-asteroid assertion proves
the intended scene; no native audio, gesture, input, thrust, no-shot,
player/session/socket, preference assertion or timeout was weakened. Its success
receipt includes the empty-scene epoch. No server or fixture helper changes were
needed for this repair. TypeScript and changed-file Biome exited zero. One native
Mac ARM development run passed all six Chromium/WebKit viewport cases in
33.73 seconds, with runner and evidence-retention exits zero. Preserve
`/tmp/georoids-pr2-audio-empty-scene-focused.log` and
`.performance/audio-empty-scene-focused`. Pinball diagnostic server/helper edits
occurred around its startup, so this development run does not prove a frozen joint
tree. A final combined audio/pinball focused run and complete gate remain required;
the historical native lifecycle cause in #714 and the clean ARM/x64 repeated
acceptance sample remain unresolved. The runner cleaned its owned services and released the
repository lock before the pinball investigation began.

Pinball gate-three cause remains unproved: its failed desktop and passing touch
launch artifacts had identical geometry, and the desktop pilot did not die.
The added diagnostic run passed both cases in 6.98 seconds with an accepted
projectile ID and three authoritative bounces; it does not explain the earlier
zero-bounce failure (`/tmp/georoids-pr2-pinball-diagnostic.log`). The guarded
pinball fixture now installs exactly three identified bumpers using canonical
`layoutReflectiveCluster`, arranges a live pilot with an exact motion epoch, and
removes natural-field dependence without changing production gameplay. The test
still fires one real normal shot, requires exactly one non-null server receipt,
and measures at least three authoritative bounces for that accepted ID. Selected
server rock rows, launch pose, current epoch and accepted/rejected shot receipts
remain in artifacts. Bounded ID observation rejects non-array, over-30 and long
ID requests; dead-pilot arrangement remains atomic and never resurrects it.
Cleanup attempts artifact capture, restoration and each handle disposal in
sequence, retaining original and cleanup errors even when capture fails.
The final frozen joint run passed all nine cases across the six-case audio file,
pinball and shared-field in 47.96 seconds
(`/tmp/georoids-pr2-pinball-audio-frozen-focused.log`). An earlier five-case
combined sample selected the unrelated two-case resource-tap audio file; it is
retained at `/tmp/georoids-pr2-pinball-audio-final-focused.log` and does not stand
in for the required six-case audio proof. The full gate remains pending root.
Final endpoint/physics/cleanup contracts passed 22 tests across three files in
4.15 seconds (`/tmp/georoids-pr2-pinball-final-unit.log`). TypeScript, Biome,
Knip, ts-prune, Markdown and diff checks passed with independently inspected exit
codes. Wiki source review initially flagged only the changed pinball and audio
browser demonstration sources; reviewing their guarded setup and unchanged
player rules/assets required no article or media edits. The documented review
accepted those current sources, then Wiki validation passed. No owned development
session remains. These are native arm64 dirty-tree samples; gate four, shipping
and clean-release verification remain root-owned and pending.

PR 2 shipped through #738 at `e0ef52be13a62e02b27590995cc4c2d612a57c67`.
Its final complete local gate passed 207 integration tests across 90 files in
847.15 seconds, then frame-work passed 120 samples and both constrained-client
cases passed. This supersedes the pending gate-four status above. Deployment
verification remains root-owned.

PR 3 integrated that exact main revision without discarding its empty live audio
fixture or canonical fixture helpers. The two remaining initial two-pilot setups,
full cargo holds and score after respawn, now join without waiting for combat
protection to expire and await named pilot epochs immediately after arrangement.
The later mining combat wait, intentional impact, death, respawn, cargo and score
assertions and timeouts remain intact. Their three focused cases passed.

The first merged PR 3 native Mac arm64 diagnostic failed with runner exit 1:
four of nine intended cases passed, five audio cases failed in 64.55 seconds.
Retain `/tmp/georoids-pr3-merged-focused.log` and
`.performance/pr3-merged-focused-failed`. Chromium landscape and all three
WebKit cases observed the old native context closed and replacement running,
but the native replacement clock did not advance within the existing poll.
WebKit's initial native clock was already zero before the forced diagnostic
stall. This proves the observed native clock failure in this attempt, but does
not identify its cause or reproduce the historical cached-state mismatch.
Chromium mobile completed its audio scenario and then failed in the shared
post-test fixture evidence capture because navigation destroyed the evaluation
context. No behavior change or retry was made after these failures.
Vitest also discovered an ignored integration-backup test copy and rejected its
relative import. That copy is preserved outside test discovery at
`/tmp/georoids-pr3-main-integration-backup-20260930`; its failed suite remains in
the original log. The first receipt unit command likewise discovered the backup
unit copy and passed six tests across two files, rather than the intended three.
The seven repeatability Node contracts and TypeScript check independently exited
zero. The runner terminated its owned services normally after the failed sample.
Clean pinned native ARM/x64 twenty-attempt and three-full-suite acceptance,
round-two review and the full local gate remain outstanding. Instrumentation and
fixture setup change no player controls or Wiki topic; no article changes apply.

The corrected receipt unit discovery passed its intended three tests in one file
with exit zero. Markdown, changed-file Biome and the automated `check:actions`
command also exited zero. Two bounded independent native clock controls then
completed with exit zero. Fresh trusted mouse/touch controls on Chromium and
WebKit compared the raw `BaseAudioContext.currentTime` getter with ordinary
reads, both with and without the probe. The second control exercised 24 looping
buffer contexts with repeated page-owned disposal in shared browser instances;
all clocks advanced about 0.47–0.51 seconds across their observations. Retain
`/tmp/georoids-pr3-native-clock-control.log`,
`/tmp/georoids-pr3-native-clock-control-disposal.log` and
`.performance/native-clock-control-disposal`. These later controls do not prove
why the game scenario's initial clocks stalled in the earlier failed sample.
No playback emulation, launch authorization bypass or runtime fix was introduced.
The diagnostic source is preserved outside test discovery at
`/tmp/georoids-pr3-native-clock-control-diagnostic.ts`.

The native probe now also reads the original base-class clock getter, and the
scenario requires initial native clock progress before deliberately freezing its
observed clock. Its final Wiki navigation records main-frame navigation events
and awaits the intended URL, load and complete document before finishing. This
is a guarded observation/barrier change, not proof of a navigation root cause;
its focused native validation is pending while PR 4 owns the machine. Original
capture errors are still propagated and independently retain server evidence.
The added getter initially failed TypeScript narrowing; correcting its bound
reader made the final TypeScript check exit zero. Changed-file Biome then exited
zero. No browser/integration/performance process remains owned by PR 3.

The latest frozen PR 3 native Mac arm64 audio diagnostic passed all six cases in
one file in 35.92 seconds with runner exit zero. Retain
`/tmp/georoids-pr3-native-focused-initial-raw.log` and
`.performance/native-focused-initial-raw`, including revision/diff/native metadata,
logs and current lifecycle receipts. Initial and replacement native clocks
advanced, raw base-class and superclass values agreed, capture/scenario errors
were null and every trace reported zero dropped entries. All existing playback,
trusted gesture, player/session/socket/input, no-shot and preference assertions
completed. Wiki navigation completion barriers passed, and receipts retained
both main-frame URL events. This is one frozen dirty-tree diagnostic success,
not an explanation for the earlier failed sample or the historical #714 mismatch,
and not the clean native ARM/x64 20+3 acceptance sample. Owned services stopped;
PR 4 received machine ownership immediately after cleanup.

Scoped Wiki review covered HUD/audio/haptics/diagnostics, cargo capacity and
banking, death and respawn guidance against the changed title and crew fixtures
and native probe. Player-visible behavior and media are unchanged. Wiki review
initially reported precisely two changed source hashes, `package.json` and the
title-music scenario. Accepting those reviewed sources changed only those hashes
and the review note; the next Wiki check passed. No unrelated source hash or
article/media baseline was regenerated. PR 3 round-two review, full gate and
post-merge repeated native acceptance remain outstanding.

PR 4 shipped through [#739](https://github.com/jsolly/GeoRoids/pull/739) at
`7fb51d985dff87d6429d2a6037509afa47998e96`. Its verified staged tree was
`4bcd470b47161dc58cd81c3f342ada3d3eb6805c`. The first gate passed 1741 of 1742
unit tests and failed the Wiki source digest contract. Scoped review of the
changed authoritative-bolt test repaired that baseline; the subsequent complete
gate passed static checks, units, build and all 207 integration tests across 90
files in 933.39 seconds, followed by 120 frame-work vectors and both constrained
cases. Owned runner processes cleaned up. The first failure remains part of the
record rather than being replaced by the later success.

[CI 36745568279](https://github.com/jsolly/GeoRoids/actions/runs/36745568279)
passed on exact head `d2be0702786fe17f59831c413c0806976c0568c4` before merge.
Vercel deployment `dpl_fWQX1Nnm7gi49zw3CGMTbAweiNP8` reached READY and its
release header matched the merge. Railway deployment `6764872994` succeeded at
that exact merge, with healthy worker persistence, `failed: false` and zero
simulation stalls. [Production smoke 36746083077](https://github.com/jsolly/GeoRoids/actions/runs/36746083077)
completed exact request `6764872994`; its receipt reported client and server
release `7fb51d985dff87d6429d2a6037509afa47998e96`, `errors: []` and
`success: true`. Gameplay received 76 snapshots and fired through the real UI
with request `33e7c734-e5a3-4eb0-ba51-1404bf2c9522` and a non-null acknowledged
projectile. Client, server and production firing are verified for that release.

The production-follow helper's workflow-title matcher was corrected. Its failed
artifact lookup still expects `production-smoke-ID` while the actual name is
`release-ID`; this separate helper repair remains on existing external Todoist
`6hfmw9hqc4jw9Qvc`. PR 3's six affected round-two semantic review lenses completed
without findings or fingerprint change. Its full gate and clean native ARM/x64
20+3 acceptance remain pending; no historical #714 cause is declared fixed.
