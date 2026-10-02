# Backlog implementation plan

The approved sequence contains 16 feature groups. PR 7 is split into runtime
capability injection and a separate measured loot-index repair PR. Status describes implementation progress,
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
| 2 | Fix fixture determinism and retain actionable failure evidence for #715 and #716. Prove failures expose the cause without retries or weaker assertions. | Shipped [#738](https://github.com/jsolly/GeoRoids/pull/738), `e0ef52be`; historical investigation criteria remain open | Triage `6hfFQfq4PP367Vxv`; furnace `6hg2qp9VMh6vjr9M`; crawler `6hg2qpCc5VMq6hMv`; harness parent `6hfFQcvww7gHj4Mv`; human schedule `6hf8pMC4JVjgvgQv` |
| 3 | Fix WebKit audio and obtain cross-architecture proof for #714 and #717. Run 20 focused repetitions and three full suites on native ARM and x64. | Shipped [#740](https://github.com/jsolly/GeoRoids/pull/740)–[#743](https://github.com/jsolly/GeoRoids/pull/743); native 20+3 sample passed on both architectures at `38b79c1a`; historical criteria remain open | Audio `6hg2qp9cFGqMMCFM`; umbrella `6hg2qp7XVWfCCQGv`; same triage, harness parent and human schedule as PR 2 |
| 4 | Prove authoritative firing in production. A correlated non-null `shotAcknowledged` is sufficient even if a collision consumes the bolt before a snapshot. Reject missing, null, wrong or stale acknowledgements; malformed snapshots still fail. | Shipped [#739](https://github.com/jsolly/GeoRoids/pull/739) | Projectile `6hfP8334Q638373M` |
| 5 | Run six isolated integration shards three times, each run under 600 seconds; retain 300 seconds as a future performance target. Preserve isolation and failure evidence. | Shipped [#746](https://github.com/jsolly/GeoRoids/pull/746); approved 600s bar met | Shards `6hcHJM3WrR7Hh9CM` |
| 6 | Normalize full pre-commit checks, preserving the existing fleet documentation fast path exception, and scope Wiki source review to affected behavior. | Shipped [#747](https://github.com/jsolly/GeoRoids/pull/747), `abb78c0b` | Gate `6hcHJJjhGW7p6rFM`; Wiki `6hcHJJmG74wPCghv` |
| 7 | Inject targeted runtime capabilities, then repair measured global loot scans in a separate PR. Preserve atlas knowledge, loot motion/expiry and guard discovery ordering; leave already-bounded indexes unchanged. | Runtime implementation in progress; index design reviewed | Singleton `6hcHJJrWqGh6qFqM`; index `6hfGCG7hM6rmgCfv` |
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

### Native audio repair and remaining fixture evidence

The later native run [36768091849](https://github.com/jsolly/GeoRoids/actions/runs/36768091849)
completed all 23 attempts per architecture at `c9038068`, with every failure
retained. ARM passed 14 of 20 focused attempts and all three full suites;
x64 passed 10 of 20 focused attempts and one of three full suites. Focused
failures all observed one native source after mute. The two failing x64 full
suites observed a 350-versus-300 delivery reward; one also observed an unchanged
150-HP mining target. Their original causes remain unproved. The receipts omit
the selected belt rock, accepted shot and terminal hit, carried cargo and
identified delivery rewards. The next fixture repair must retain that evidence
and establish an authoritative zero-cargo delivery baseline without weakening
the exact assertions or adding retries.

Audio repair [#742](https://github.com/jsolly/GeoRoids/pull/742) landed as
`bb160a81ad33613147ca6f86d63d3b61fe88b207`. A real native sample with an explicitly
injected early Howler wall-clock end reproduced a source remaining active after
mute. A second native overlap regression reproduced reuse of that source's gain
and panner. The repair owns sources until native completion and reserves their
Howler pool rows; mute stops and disconnects both identified voices while their
independent controls and pilot identity remain intact. Three regression browser
cases, 63 audio unit cases and actual desktop/touch Sound Effects controls passed.
These controlled reproductions do not establish the unobserved historical
Howler handle state in the original remote failures.

Two semantic review rounds retained and fixed the confirmed pool-reuse finding.
The first full gate failed scoped Wiki digest validation; the second was stopped
after static checks, units and build to repair that finding. Both attempts remain
retained. The final complete gate passed static checks, units, build and all 210
integration cases across 91 files in 706.50 seconds, followed by 120 frame-work
vectors, both constrained-client scenarios and cleanup. The report-only frame
observations exceeded contour endpoint-read and pickup position-read baselines;
retain them for the runtime audit rather than claiming those observations passed.

[CI 36780446214](https://github.com/jsolly/GeoRoids/actions/runs/36780446214)
passed on exact head `84ab3485e1934aa685d2d62af8205e9da051dc3b`. Vercel and
Railway independently served the exact merge; Railway reported worker
persistence, no failure and zero stalls. [Production smoke 36780825363](https://github.com/jsolly/GeoRoids/actions/runs/36780825363)
validated request `6770738197`, exact client/server releases, 52 decoded snapshots
and an accepted real-UI shot, with no errors. The canonical helper now downloads
the actual artifact but rejects its existing receipt field names; direct
validation of the retained receipt verified the successful run without another
dispatch. That external helper issue remains on `6hfmw9hqc4jw9Qvc`.

The required clean native ARM/x64 20-focused-plus-three-full acceptance remains
open. Address the retained crew fixture failures before sampling the final
revision. The audio checkout was archived after its evidence and production
receipts were preserved; continuing fixture work uses a fresh `origin/main`.

### Crew fixture observations

The pending fixture repair uses the actual arranged belt-rock identity and
retains socket admission, projectile collision competition, terminal targets
and before/after health. Recording is opt-in for local test servers, bounded,
and cleared by reset. Delivery arrangement establishes zero carried cargo while
preserving banked score, then retains each pilot's exact Town Square reward.
The assertions still require mining damage and 300 points for each contributor.

Development verification passed 31 unit cases across four files and five browser
cases across the mining and delivery files. Both mining receipts recorded an
accepted shot hitting the identified belt rock from 150 to 125 HP, with no
capture errors or dropped records. Delivery receipts recorded zero initial
cargo and separate 300-point rewards for both pilots. These controlled browser
shoot commands exercise client, socket and server behavior; they do not prove
native keyboard or touch firing gestures. One field-manual browser case also
passed desktop and mobile navigation. Only the three actually reviewed watched
source hashes were accepted; unrelated Wiki hashes remain unchanged.

The first full semantic review found one reset-observation coverage gap, which
independent adjudication classified as Minor. The remaining six lenses found no
material issues. The bounded follow-up tests a valid shot after reset without re-enabling
observation and adds both crew files to every native focused attempt. Its 19
fixture unit cases and eight repeatability contracts passed. One local focused
attempt passed all 23 cases across six files in 84.43 seconds, with exact
coverage verified by the strict report reader. This dirty-tree run does not
establish native repeatability. A complete gate, final review and clean native
architecture sample remain required before the phase's acceptance can close.

## Native repeatability accepted on September 30

Crew fixture repair [#743](https://github.com/jsolly/GeoRoids/pull/743) shipped
as `38b79c1ae40fbb39f2c99c126e7a84f442c159c4`. Its complete local gate
passed 210 integration cases across 91 files in 695.75 seconds, alongside
static, unit, build, frame-work and constrained-client checks. Exact-head CI,
Vercel, Railway and the deployment-specific production smoke were verified.
Report-only contour and pickup work observations remain inputs to PR 7.

[Native run 36788889181](https://github.com/jsolly/GeoRoids/actions/runs/36788889181)
completed the same merged revision on native Ubuntu ARM64 and x64. Each
architecture passed twenty focused attempts containing all six files and
23 cases, then three complete suites containing all 91 files and 210 cases.
All 46 runner receipts exited zero with no skipped/todo tests, hidden retries,
output, evidence or cleanup failures. Root and an independent reviewer checked
every nested Vitest report and retained receipt; the reviewer also checked all
7,248 retained changed-artifact hashes and 1,946 complete teardown receipts.
Full runner durations were ARM64 986.355/994.795/1007.181 seconds and
x64 936.937/936.708/945.235 seconds. These remote serial durations do not
establish the local sharding performance target.

Artifacts, previous failed samples and the independent acceptance receipt remain
under `/Users/johnsolly/.local/state/georoids-backlog/20260930/pr3/`. The approved
repeatability sample is accepted and permits PR 5. It does not prove zero
flakiness or explain the unobserved historical #714 and original crew causes;
those limitations remain explicit in the linked investigations. The human
scheduling checkbox and harness parent remain open.

## Original triage inventory

On October 1, GitHub #714–#717 were closed with “Moved to Todoist.” Their
technical work was already in the approved plan; the four new records do not
represent completion or additional gameplay scope. Current investigation homes
are [native determinism](https://app.todoist.com/app/task/6hg2qp7XVWfCCQGv),
[WebKit lifecycle](https://app.todoist.com/app/task/6hg2qp9cFGqMMCFM),
[furnace travel](https://app.todoist.com/app/task/6hg2qp9VMh6vjr9M), and
[crawler fixture lifecycle](https://app.todoist.com/app/task/6hg2qpCc5VMq6hMv).
GitHub readback confirmed closed, rather than deleted, issues. Preserve the
original evidence and every remaining acceptance condition in these task homes.

A source/artifact audit of the original local review runs found 24 failed cases:
`LAy1ic` had 15 cases across 11 files, `w2Uwyg` had eight across five, and
`LiA98J` had one. The task notes counted failing files. The prepared-fixture
snapshot sequence race is directly addressed by #710 stopping periodic
broadcasts before counting fixture snapshots. Intentional join rejection and
injected reset failures occurred in passing tests and are not additional defects.

The remaining 23 browser failures have relevant shipped repairs and current
regression evidence, but their original causes remain unproved. Their exact
observations and missing provenance are explicitly retained in
[the existing #717 investigation](https://github.com/jsolly/GeoRoids/issues/717#issuecomment-5922765886).
Copied screenshots and contradictory printed source frames do not establish
original execution state. The triage checkbox remains open while its full
classification criterion is reconciled; the accepted native sample is not
used to assert historical causes.

## Sharding development evidence

The first real six-shard run, `run-2AULLi`, failed during service startup:
the `tsx` CLI's Unix socket exceeded the usable path length inside the isolated
temporary directory. A same-path comparison and real server contract verify
that `node --import tsx` reaches health and cleans up successfully. Independent
review also required shard-owned Wiki output and sticky console-write failure
handling. All three repairs passed their bounded checks and independent review.

The second real run, `run-CLLp7s`, exceeded the end-to-end deadline at 302.74
seconds. It completed 104 cases, including 17 failures, before stopping; no
complete Vitest report exists. All six runner cleanup receipts succeeded, and
source fingerprints were unchanged. Independent servers reported synchronized
multi-second stalls. Their cause needs measured diagnosis; this run establishes
neither complete coverage nor the performance target. Both failures remain
retained under the backlog evidence home. Three complete successful runs below
300 seconds, full gate, shipping and deployment verification remain required.

The first balanced run, `run-viJk2s`, used six partitions with at most three
active runners. It exceeded the deadline at 305.35 seconds. Three partitions
passed all 93 assigned cases; the other three had no complete reports. The
console recorded 180 completed cases without a printed case failure before
termination, which does not establish full coverage. Source fingerprints were
unchanged. Expanded discovery took about 45 seconds, and the first three
partitions took 132–150 seconds each.

The coordinator's three-second cancellation escalation killed the remaining
runners before they wrote cleanup receipts. Later inspection found all twelve
ports closed, all six runner PIDs absent, and the common lock absent; that
inspection does not replace the missing receipts. Independent review also
identified an owner path that cleared the coordinator PID after a crash without
verifying detached-child cleanup. Both cancellation defects require repairs
and regression evidence. The successful-run limit remains 300 seconds.

The subsequent cancellation repair passed 23 unassisted runner contracts on
frozen source. These cover slow cleanup, repeated signals, inherited output
pipes, coordinator and owner crashes, discovery ownership, and a crash between
child spawn and authorization. Ownership records precede authorization; unknown
ownership retains a lock marker that also blocks stale-lock reclamation.
The imported discovery entry's nonzero exit status is preserved. Types, lint,
Actions, and runner checks also passed. Earlier development failures and the
manually assisted development run remain retained and do not count as accepted
verification. These bounded results do not establish the integration timing
target or a shipped release.

The reviewed Node collector preserves per-file isolation and dynamically expanded
registration. Matching frozen-source diagnostics collected the same 91 files and
210 source-located case identities in jsdom and Node. They took 43.72 and 20.81
seconds respectively, with successful ownership cleanup and no collected or
unhandled errors. Collection executes setup modules and registration callbacks;
it does not execute test lifecycle hooks or bodies. These results establish
collector equivalence for this tree, not gameplay success.

The first full run using that collector, `run-ZY4qL0`, exceeded the deadline at
305.07 seconds. All six cleanup receipts succeeded without forced killing;
185 cases printed success, two printed failure, and 23 remained incomplete.
Three completed partitions passed all 93 assigned cases. A laser assertion failed
before cancellation because a pilot took asteroid damage during joining, then
regenerated health during the exchange. A controlled joining repair passed independent review and both affected
laser scenarios in a focused runner execution. The mobile spider scenario's
failed teardown began after cancellation, but retained evidence does not prove
its body succeeded. Historical case-only weights omit worker and fixture costs;
further measured savings are required before timing acceptance.

Independent import and design reviews found no worker-DOM requirement in the
79 Playwright scenario files. Each now explicitly selects a Node worker;
actual Chromium/WebKit pages, fresh contexts, shared setup and per-file isolated
serial execution are preserved. Entity and unit DOM environments retain their
existing configuration. A representative runner sample passed all 12 files and
24 cases, including both engines' audio recovery and touch interactions, HUD
layout, shared delivery, lasers, Wiki and client refresh. Its Vitest duration
was 92.86 seconds. This compatibility sample does not establish full-suite
coverage or the 300-second sharding target.

The subsequent full run, `run-9alfLN`, exceeded the deadline at 303.50 seconds.
The first three partitions passed all 93 cases with lower Vitest durations of
123.99, 130.90 and 140.26 seconds. A fourth partition passed its 48 cases.
The final two were interrupted. Their crashed-page evidence appeared after
cancellation, so it neither proves completed bodies nor establishes independent
assertion regressions. All six cleanup receipts succeeded, and checkout
fingerprints matched. Full-suite timing acceptance remains unmet; exact per-file
phase costs are needed before the next balancing change.

The exact timing reporter passed independent review and 30 runner contracts,
including real Vitest callback failure, runtime identity and late source-change
checks. Its first full measurement, `run-XrenSn`, exceeded the deadline at
303.73 seconds. It retained 88 ended file rows totalling 790.72 seconds of tracked
work; four complete child receipts account for 60 rows, and the other rows remain
observations from partial receipts. All six runner cleanup receipts succeeded.
These measurements do not establish a complete baseline or performance pass.

The measured three-slot projection leaves insufficient margin. Independent
review approved a bounded four-slot experiment with six serial shards: two
larger and four smaller partitions use relative capacities `2, 2, 1, 1, 1, 1`.
Proposed weights preserve partial and missing-observation provenance. An actual
run must verify stability, CPU/memory pressure, loop behavior and all acceptance
criteria. This schedule is being implemented; no four-slot run has passed yet.

### Current-main integration before four-slot measurement

PR #744 landed while PR 5 was in progress. The branch now starts at `26dec1c9b8258f312bbf445cd610561c5ede4b64`; its release, CI, Bash 5, and fleet-control changes are preserved. The seven overlapping code paths matched clean three-way merge output. The agent instruction conflict retained the new concise structure, with shard operating details also added to `docs/agent-operations.md`. Runner contracts and independent review are refreshed on the combined source before measurement; earlier performance failures and accepted narrow proofs remain historical evidence. No four-slot full run has passed yet.

The first four-slot attempt, `run-3suNk7`, failed after 151.87 coordinator seconds (152.24 seconds including the runner). The 1280-pixel nearby-crew audio scenario observed two explosion cues where it expected one; this was a genuine pre-deadline assertion failure. The coordinator cancelled the other active work and all four launched shards confirmed cleanup. Source fingerprints before and after matched. Retained logs prove that the listener lost health to an asteroid while the second browser joined, before the controlled empty scene was admitted. The saved artifacts do not identify the second native cue, so its precise cause remains unproved. Controlled admission and richer native audio phase evidence are being repaired without relaxing cue counts or gameplay assertions. No four-slot run is accepted yet.

The bounded spatial-audio repair is independently accepted: each pilot is admitted into a clear scene before the next joins, with exact motion epochs, live socket and full-health barriers. Native lifetime cue counts and HRTF assertions remain unchanged. Additive source identity and timing observations are retained with fresh failure-phase evidence. The complete focused direction file passed all three cases on the final source; the shared-probe Chromium/WebKit batch passed twelve cases. Desktop/touch Wiki verification passed, and only the 35 reviewed source hashes were updated, preserving 432 unrelated accepted hashes. Renewed full-run performance proof remains outstanding.

The second four-slot attempt, `run-4NEMxw`, failed after 271.58 coordinator seconds (272.06 seconds including the runner). The 390-pixel Hauler tow-bite scenario failed to latch after a spider killed its owner during fixture admission. All six launched shards confirmed cleanup, and source fingerprints matched. A crashed-page observation in another shard occurred after cancellation; its independent onset remains unproved. The saved gesture evidence does not identify why the attempted latch was absent. Neither attempt establishes performance acceptance.

Finite protected tow admission and atomic removal of protection passed four focused browser cases and 32 unit cases, but independent review found that ordinary test placement also clears the Hauler cable. Those retained passing results do not establish a towed owner bite. A narrowly validated test-only placement path must preserve the already confirmed captive during owner placement, reject mismatched targets before mutation, and prove the attachment in its atomic release receipt. Normal placement and production combat remain unchanged. Full sharding acceptance still requires three complete runs below 300 seconds, followed by the full review gate and shipping.

The corrected tow fixture now validates both live motion sessions, exactly one Tow Cable owner and the expected living terrain spider before mutation. Explicit placement preserves the existing owner attachment; ordinary placement still clears it. The unit proof calls the real spider advancement and verifies that the exact lethal attack occurred with the captive in the tow mapping. All 35 focused unit cases and four keyboard/touch browser cases pass, with fresh matching release receipts and no capture failures. The earlier insufficient passing proof and failed correction attempts are retained. Independent exact-source review precedes renewed full timing measurement. Scoped Wiki review updates only the motion and tow-browser source hashes, retaining 465 others; gameplay rules and illustrations are unchanged.

### Approved timing adjustment — October 1

John approved a 600-second end-to-end acceptance limit for three complete runs. The 300-second goal remains a future performance target and no longer blocks shipping. Historical failed-run receipts above retain their original deadlines. All cases, failure checks, source identity, isolation and cleanup requirements remain mandatory. Further cache A/B performance experiments are stopped; correctness review and complete validation take priority. The current schedule is six equal-capacity serial shards with at most three active children. No complete successful sharded run has yet been accepted.

Three consecutive complete runs on identical source passed all 91 files and 210 cases with no aggregate errors: `run-VpnQH7`, `run-9H52no`, and `run-7XKjzs`. Coordinator durations were 301.677, 335.425 and 365.243 seconds; runner-inclusive durations were 302.28, 336.14 and 365.86 seconds. These satisfy the approved 600-second timing bar, not the 300-second target. Independent receipt review, the full gate and shipping remain required.

### PR5 shipping receipt and PR6 start

PR5 shipped in [#746](https://github.com/jsolly/GeoRoids/pull/746), merge `c1d401ab296deb7932861c65d87f214907f64187`. CI and full local gate passed; final gate integration passed all 91 files and 210 cases in 378.25 seconds, with 120 frame-work vectors and both constrained-client scenarios. Full semantic review fixed the temporary Git fixture environment, stale unit evidence mocks and operating instructions; both review-round checkout fingerprints were unchanged. Vercel and Railway independently serve the exact merge, with healthy worker persistence and zero loop stalls. [Fresh production smoke](https://github.com/jsolly/GeoRoids/actions/runs/36912124654) passed for deployment/request `6792855590`, including exact server admission, 40 accepted snapshots and a correlated authoritative shot acknowledgement. The sharding Todoist record is complete; its parents remain open.

PR6 starts from that merge with independently accepted design. One complete gate entry sits behind the existing hook preamble; manual gate uses the same hook with the fleet-docs fast path disabled. Exact content/tool/install and final stage/cleanup receipts permit reuse only for unchanged verified work. Literal-only changes may reuse graph evidence while still running gameplay checks. Wiki acceptance patches only explicitly reviewed changed sources and affected topics. Final benchmark cleanup receipts and the CI gate-wiring contract are included in this phase.

PR 6 shipped as [#747](https://github.com/jsolly/GeoRoids/pull/747), `abb78c0b`.
The final merged-branch gate passed 1,771 unit cases and all 91 integration files /
210 cases in 336.391 seconds, plus frame and constrained-client checks and cleanup.
CI run `36940106475` passed; Vercel and Railway independently served that release
with healthy worker persistence and zero stalls. Fresh production smoke
`36940611110`, request `6797452725`, passed. Gate and Wiki Todoist records are closed;
historical investigations and parents remain open.

An existing development-only `brace-expansion` 5.0.9 vulnerability was identified
by the dependency-install audit and was present before PR 6. A separate dependency
fix follows both PR 7 changes before PR 8; preserve the audit evidence and validate the patched
lockfile. This is ordinary own-repository repair, without a Dependabot drain.

The PR 7 index audit identifies global restored-point-loot scans in collection,
motion/expiry, snapshot materialization, laser targets and guard-resource discovery.
The index repair remains part of this phase and follows the runtime injection PR
before controls work. It requires local spatial queries and motion/expiry subsets,
with an independent incremental chart-asset catalog so distant known salvage and
existing guard markers are retained. SQLite, asteroids, contours, the finite civic
furnace catalog and capped spider-body queries already meet the measured locality
bar; no speculative indexes are added. Detailed measured baselines and the reviewed
algorithm design remain in the external implementation evidence directory.
