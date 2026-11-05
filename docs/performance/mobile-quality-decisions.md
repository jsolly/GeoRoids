# Mobile graphics decisions

## Current production policy

Native device resolution remains enabled during ordinary desktop and touch
flight, and full glow remains enabled on every device except low-end ones.
`src/rendering/renderQuality.ts` owns those settings;
`src/rendering/canvasSurface.ts` applies their backing resolution. No global
flight-resolution or glow reduction has been accepted.

Low-end devices fly, and draw the spawn fly-in and universe map, without cosmetic
glow by default. `src/rendering/deviceCategory.ts`
classifies the device once per session, using the same rule that selects
simplified Scan below; `renderQuality.ts` then chooses the `low-end` preset,
reported as graphics source `low-end-default`. Hull, projectile and effect
geometry, colours and core strokes are unchanged; only shadow blur is removed.
`/debug?performance=collect&renderGlow=full` remains the higher-quality control.
See [Low-end flight glow](#low-end-flight-glow) for the evidence and its limits.

Low-end Mineral Scan uses a separate simplified view, selected by
`src/rendering/scanDetailPolicy.ts` for the known Fire model `KFTUWI` or a coarse
pointer with valid browser hints of at most 4 GB memory and four logical cores.
Other devices retain full Scan detail. `src/rendering/canvasSurface.ts` and
`src/rendering/simpleScanRenderer.ts` paint the simpler live scene directly into
the visible canvas at no more than DPR 0.75, one million backing pixels, and a
1536-pixel maximum dimension. Distant terrain is coarser; hazards, ships, shots,
navigation and controls remain live, and flight resolution returns afterward.
These presentation choices preserve physics, weapon timing, collisions, and
snapshot contents.

[PR #855](https://github.com/jsolly/GeoRoids/pull/855) shipped this Scan policy.
The [Fire tablet record](fire-tablet-experiments.md) preserves its short physical
Canvas test with glow off and the release receipt. John waived the longer test
as a shipping condition; sustained, thermal and full-glow acceptance remain
unqualified. An iPhone 16e is also available, but its OS/Safari version and
hands-on recordings remain pending. Desktop throttling does not establish
physical-device acceptance.

## Controlled comparisons

The following URL parameters are accepted only with `performance=1` or
`performance=collect`. They select a fixed setting for that diagnostic session;
they are not persistent player preferences or automatic adaptation.

| Parameter | Values | Effect |
| --- | --- | --- |
| `renderDpr` | `native`, `2`, `1.5`, `1`, `0.75` | Cap flight backing resolution; never upscale a lower-DPR screen |
| `renderGlow` | `full`, `off` | Retain or suppress cosmetic canvas shadow blur |
| `scanDetail` | `auto`, `full`, `simple` | Use device policy or force Scan detail for that visit |

For example, `/?performance=collect&renderDpr=2&renderGlow=full` compares DPR 2
while retaining glow. First compare resolution and glow independently. Then
compare combinations of successful settings. All touch coordinates, viewport
geometry and camera projection remain in CSS pixels.

On a native-DPR-1.5 tablet, caps 2 and 1.5 do not reduce the flight backing store.
Use cap 1 for the first flight-resolution comparison; cap 0.75 is a softer
diagnostic candidate. Simplified Scan keeps its separate DPR and backing-size
limits, so a flight cap of 1 does not reduce it further. See the
[Fire tablet record](fire-tablet-experiments.md).

| Candidate | Visible tradeoff | Status and removal comparison |
| --- | --- | --- |
| DPR cap 2 | Softer thin lines and text on higher-density screens | Experiment only; compare native resolution |
| DPR cap 1.5 | Greater softness, particularly distant projectiles and text | Experiment only; compare DPR 2 and native |
| Flight DPR cap 1 | Softer canvas text and thin lines on DPR-1.5 tablets | Experiment only; compare native flight at the same glow |
| Flight DPR cap 0.75 | Noticeable softness below CSS-pixel resolution | Experiment only; compare cap 1 and inspect distant hazards |
| Glow off | Less luminous hulls, projectiles, scan pulses, effects and map marks | Default on low-end devices ([Low-end flight glow](#low-end-flight-glow)); elsewhere experiment only, compare full glow at the same DPR |

No measured performance improvement is claimed by the presence of these controls.
The numerical target is sustained 60 Hz presentation on supported physical devices,
with fewer than 1% gameplay intervals above 25 ms and p99 at or below 33.3 ms.
Handler-to-render p95 must remain below 33.3 ms with at least 300 distinct inputs.
Client frame CPU p95 must remain below 10 ms; compare CPU and input regressions
against the A/A noise alongside frame pacing.
These are scheduling/submission measures, not GPU presentation guarantees.

## Accepting and retiring a reduction

Every future accepted cap, glow reduction, render cadence limit or slower HUD
refresh needs its own entry here before changing the production preset. Record
any owner-approved exception separately from completed measurements, as with
the shipped Scan policy above. For qualification, record:

- Exact setting, activation rule, owning source and accepted release.
- Actual phone models, OS/browser versions, refresh and power conditions.
- Baseline/candidate source and harness hashes, raw report paths and checksums.
- Per-session A/A variation and paired effects, including failed/incomplete runs.
- Visual captures and the specific loss of sharpness, glow or responsiveness.
- Five-minute paired measurements and fifteen-minute sustained acceptance on the
  affected device cohorts, plus minimally instrumented checks.
- The higher-quality control and the passing test that will remove the reduction.

For a future flight reduction, choose one fixed touch preset, preferring the
highest passing DPR, then full glow at that DPR. Native/full wins whenever it
meets the target. Treat these numerical targets as review references, not CI gates. Change them
explicitly when feature costs or supported-device expectations justify it, and
record the reason and evidence. Do not infer Android acceptance from an iPhone result.

Retest each reduction against its higher-quality control after a general
performance improvement or a supported-device change. Remove or relax it when
the higher-quality version passes the same paired and sustained checks on both
supported cohorts. A faster new phone alone does not retire protection for an
older phone that remains supported. Delete obsolete branches, migrate tests,
update the Wiki and source review, and record the retirement evidence here.

## Low-end flight glow

- **Accepted release:** [PR #896](https://github.com/jsolly/GeoRoids/pull/896),
  merge commit `0f1582bc61d1c933af0b13b5f6b08cae30a7ebdf`, with a passing
  [production smoke](https://github.com/jsolly/GeoRoids/actions/runs/41200237760),
  for flight. The spawn fly-in chart and universe map joined the preset in the
  next change to `src/ui/universeMap.ts`, which routed their blur through
  `resolveGlow`; `git log -- src/ui/universeMap.ts` identifies its release.
- **Setting and rule:** glow off for flight, the spawn fly-in chart and the
  universe map on devices `classifyDevice` reports as `low-end` — the measured
  Fire model `KFTUWI`, or a coarse pointer with valid hints of at most 4 GB memory
  and four logical cores. Owned by `src/rendering/renderQuality.ts`, wired in
  `src/rendering/canvasSurface.ts`; the overlays' blur sites in
  `src/ui/universeMap.ts` read the same setting. Ship-picker and inventory
  schematics keep their glow.
- **Approval:** John chose this owner-approved exception on 2026-10-31 to resolve
  two Fire tablet debug reports, in place of the paired five-minute and
  fifteen-minute qualification this document otherwise requires. As with the
  Scan policy, that exception is recorded here separately from measurement.
  On the same day John asked for the spawn fly-in chart and universe map to
  follow it too, after review found they still drew glow on the Fire profile;
  no separate measurement covers those overlays.
- **Evidence:** on one Fire HD 10 (KFTUWI, Android 11, Chrome 152, Canvas,
  native DPR 1.5, 800×1094 CSS, 1200×1641 backing, Scout, sound and music on),
  a 61.7-second full-glow recording ran at 32.36 FPS with 81.8% of intervals over
  25 ms, and a 62.9-second glow-off recording ran at 59.95 FPS with 0.11% over
  25 ms. Full glow is report `5a024452-20b2-473c-b53d-3f80d6c6105c` (13,696 bytes,
  SHA-256 `cca333f7d80ab4cd1678ae14a2d7c47b82a8e63f577cd6e14238a8d9d36c79ba`);
  glow off is its paired report on Todoist task `6hpJRq5cXxPVQhMv` (12,520 bytes,
  SHA-256 `18bc7868fd72574846e7f5ce45da973293eb70d81dfead093ee92cfa814d1d2e`).
  Both carry client runtime release `4e6ecee18ba8b200c0d6ecbd5b99160da35f9e51`, a
  token with no matching Git revision, against a `dev` server. Both reconstructed
  through `scripts/read-debug-report.ts` on 2026-10-23. Scenes differed and only
  summaries were uploaded, so this is strong directional evidence, not a
  controlled effect estimate. A later report,
  `2e0f42bd-4d5b-4314-9b84-39290eed2b38` (16,703 bytes, SHA-256
  `32fe57aaf6bc14b89ecea0798e37cc69928eb204d8d3d8c12ee57f7b9e92d063`), came on
  2026-10-23 from client and server release
  `967415b4a2c04cbe7fa1ec3b9985cbacbe893917`, after the static halo cache in
  [PR #865](https://github.com/jsolly/GeoRoids/pull/865), with touch-default full
  glow and an instantaneous 4 FPS during combat. Its manifest carries the
  delivery worker's verified-ready marker; it was not separately reconstructed
  for this record. No performance collection accompanied it, so it shows the
  halo cache did not settle Fire flight but does not measure by how much.
- **Not recorded:** refresh mode, power-saving, charging and thermal state,
  per-session A/A variation, raw interval series, visual captures from the
  tablet, and baseline/candidate source and harness hashes. No other Fire runs,
  failed or incomplete, are known for this comparison. The owner exception
  accepts the change without them; desktop and emulated-tablet captures of the
  shipped default exist only as review evidence.
- **Visible loss:** on low-end devices, hulls, shots, scan pulses, furnaces and
  effects in flight, the landmarks and furnace fire trails on the spawn fly-in
  chart and universe map, and the universe map's ship marks lose their luminous
  halo. Shapes, colours and positions are unchanged.
- **Not qualified:** sustained, thermal and battery behaviour, and any device
  other than the one Fire tablet. The low-capacity rule extends the decision to
  devices that were never measured, on the same reasoning as simplified Scan.
- **Removal test:** retire this preset under
  [Accepting and retiring a reduction](#accepting-and-retiring-a-reduction): when
  `?performance=collect&renderGlow=full` passes the same paired and sustained
  checks against glow off on the Fire tablet. The owner exception lowers the
  bar for adopting this preset, not for removing it.

## Current minimap policy

The minimap shows the local ship and other players, plus compact marks
for live asteroids, loot drops, loose Earth-observation satellite pickups, and
orbiting pickups. Marks use current entity positions, skip dead or exploding
objects, and disappear when authoritative state removes a collected or expired
object. World marks are batched by category and pilots remain on top. This policy
is part of the product HUD and is independent of the temporary DPR and glow
experiments above.

The player-only minimap comparison in
[minimap-work-results.md](minimap-work-results.md) is retained as historical
evidence from an earlier candidate. Its lower work counts do not define the
current product policy or establish a frame-rate improvement.
