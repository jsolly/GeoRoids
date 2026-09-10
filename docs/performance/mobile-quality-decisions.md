# Mobile graphics decisions

## Current production policy

Native device resolution and full glow remain enabled on desktop and touch play.
No temporary graphics degradation has been accepted. The available physical test
device is an iPhone 16e; its iOS/Safari version must be recorded with the session.
An older Android is unavailable. Desktop Chromium, including throttled sessions,
does not satisfy that missing physical-device acceptance.

The quality policy is owned by `src/rendering/renderQuality.ts` and applied by
`src/rendering/canvas.ts`. It uses the existing touch-controls capability policy,
not a phone-model list. The fixed touch preset must remain native/full until both
phone cohorts pass the measurement runbook. Quality never changes world entities,
physics, weapon timing, collisions, or snapshot contents.

## Controlled comparisons

The following URL parameters are accepted only with `performance=1` or
`performance=collect`. They select a fixed setting for that diagnostic session;
they are not persistent player preferences or automatic adaptation.

| Parameter | Values | Effect |
| --- | --- | --- |
| `renderDpr` | `native`, `2`, `1.5` | Cap backing resolution; never upscale a lower-DPR screen |
| `renderGlow` | `full`, `off` | Retain or suppress cosmetic canvas shadow blur |

For example, `/?performance=collect&renderDpr=2&renderGlow=full` compares DPR 2
while retaining glow. First compare resolution and glow independently. Then
compare combinations of successful settings. All touch coordinates, viewport
geometry and camera projection remain in CSS pixels.

| Candidate | Visible tradeoff | Status and removal comparison |
| --- | --- | --- |
| DPR cap 2 | Softer thin lines and text on higher-density screens | Experiment only; compare native resolution |
| DPR cap 1.5 | Greater softness, particularly distant projectiles and text | Experiment only; compare DPR 2 and native |
| Glow off | Less luminous hulls, projectiles, shields and effects | Experiment only; compare full glow at the same DPR |

No measured performance improvement is claimed by the presence of these controls.
The numerical target is sustained 60 Hz presentation on both physical phones,
with fewer than 1% gameplay intervals above 25 ms and p99 at or below 33.3 ms.
Handler-to-render p95 must remain below 33.3 ms with at least 300 distinct inputs.
Client frame CPU p95 must remain below 10 ms; compare CPU and input regressions
against the A/A noise alongside frame pacing.
These are scheduling/submission measures, not GPU presentation guarantees.

## Accepting and retiring a reduction

Every accepted cap, glow reduction, render cadence limit or slower HUD refresh
needs its own entry here before changing the production preset. Record:

- Exact setting, activation rule, owning source and accepted release.
- Actual phone models, OS/browser versions, refresh and power conditions.
- Baseline/candidate source and harness hashes, raw report paths and checksums.
- Per-session A/A variation and paired effects, including failed/incomplete runs.
- Visual captures and the specific loss of sharpness, glow or responsiveness.
- Five-minute paired measurements and fifteen-minute sustained acceptance on both
  phones, plus minimally instrumented checks.
- The higher-quality control and the passing test that will remove the reduction.

Choose one fixed touch preset, preferring the highest passing DPR, then full glow
at that DPR. Native/full wins whenever it meets the target. Treat these numerical targets as review references, not CI gates. Change them
explicitly when feature costs or supported-device expectations justify it, and
record the reason and evidence. Do not infer Android acceptance from an iPhone result.

Retest each reduction against its higher-quality control after a general
performance improvement or a supported-device change. Remove or relax it when
the higher-quality version passes the same paired and sustained checks on both
supported cohorts. A faster new phone alone does not retire protection for an
older phone that remains supported. Delete obsolete branches, migrate tests,
update the Wiki and source review, and record the retirement evidence here.

## Permanent minimap decision

The minimap shows the local ship, other human pilots and bots. It retains the
arena ring, headings and faction marks. Satellites, satellite pickups and
orbiters, asteroids, loot and projectiles are absent from the minimap; their
world rendering and gameplay remain intact.

This is a requested product simplification, not a temporary quality degradation.
Do not restore non-player minimap objects when graphics settings improve. Record
its isolated comparison before using this revision as the common baseline for
the resolution/glow experiments.
