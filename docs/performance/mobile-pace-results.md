# Mobile rendering and gameplay pace, September 12, 2026

## Scope and limits

This pass starts at `771acd9261d9e6b2388593923ed2cf134440cd85`.
Movement and projectiles are tuned to 75% of their previous speed; rendering
comparisons keep the original gameplay so slower motion cannot masquerade as a
rendering improvement. No physical-phone, thermal, battery, or production
performance claim follows from the desktop measurements.

## Resolution evidence

The retained production-client reports use Chromium 153.0.8010.12 on an Apple M3,
390×844 CSS pixels, device DPR 3, CPU slowdown 4, clean loopback networking,
and seeded combat. Chromium reports software Canvas and SwiftShader. These are
rendering stress tests, not an iPhone GPU model.

| Diagnostic setting | Measured seconds | Frames above 25 ms | Render submission p95 | Input-to-render p95 |
| --- | ---: | ---: | ---: | ---: |
| Native DPR, full glow | 90 | 48.88% | 2.5 ms | 4.3 ms |
| DPR 2, full glow | 90 | 1.23% | 2.1 ms | 8.1 ms |
| Native DPR, glow off | 90 | 24.26% | 2.6 ms | 4.1 ms |
| DPR 2, full glow | 330 | 5.04% | 2.2 ms | 6.7 ms |
| Native DPR, full glow | 330 | 37.32% | 2.2 ms | 3.4 ms |

All five reports passed their recording/correctness checks and reported no browser
warnings or errors. These exploratory runs are not calibrated A/A and A/B pairs.
World evolution and visible populations differ; the input tail also worsened in
the short DPR 2 run. The long DPR 2 session was already running when this task
started. An initial eight-second deterministic observation overlapped it before
the existing runner was discovered, so its timing is not an isolated comparison.

DPR 2 submits 1,316,640 backing pixels instead of 2,962,440 at DPR 3 for this
viewport, a 55.6% reduction. CSS viewport size, aiming, camera projection and
world geometry stay unchanged. Text and thin lines are softer; glow remains.
This arithmetic is not a frame-rate prediction.

Raw short-session artifacts and the CPU profile are retained under
`/Users/johnsolly/code/GeoRoids-worktrees/mobile-pace-performance/.performance/mobile-pace/`.
Long sessions are under
`/Users/johnsolly/code/GeoRoids-worktrees/mobile-measurement-baseline/.performance/mobile-pace/`.
The [compact receipt](mobile-pace-resolution-receipt.json) records checksums
and provenance.

## Path construction

Both phosphor polyline painters rebuilt the same path for the crisp stroke after
already constructing and stroking it for glow. Canvas `stroke()` retains the
current path. The crisp pass now strokes that path again without submitting its
vertices twice. Both strokes, widths, colors, alpha and blur remain unchanged.
See the [Canvas stroke reference](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/stroke#re-stroking_paths).

Independent observation reports compare exactly 120 fixed frames after 30 warmup
frames in portrait, landscape and desktop. Only the two painters change in the
rendering candidate; gameplay tuning is excluded from those comparisons.

All three viewports passed exact repeat checks, equal game outcomes and identical
final-frame pixels. Each measured frame submits 332 fewer Canvas calls: 245
fewer `lineTo` calls and 29 fewer each of `beginPath`, `closePath` and `moveTo`.
That is 18.2% fewer observed Canvas calls in portrait, 18.3% in landscape, and
6.5% in desktop. Stroke count and all measured simulation work stay unchanged.
The [work receipt](mobile-path-work-receipt.json) retains each metric separately
and the source report hashes. These counts are not weighted CPU or GPU costs.

The fixture covers 120 frames with a stationary camera and fixed gameplay at
device DPR 1. Its native-rAF CPU samples are too short and uncalibrated to make
a sustained frame-rate claim. Final-frame equality does not prove every possible
scene. Mobile control, multiplayer, and alternate-quality checks exercise the
combined product separately.

## Gameplay decision

`GAME.MOTION_SCALE = 0.75` scales shared linear acceleration, speed caps, laser
speed, asteroid drift/spin and fragment kicks, satellite/pickup motion, terrain
acceleration, and ability/blast impulses. Per-kit ratios remain intact. Bot
movement retains its existing rules and consumes the scaled shared constants.
Turning, simulation/network cadence, damage, firing intervals, cooldowns and
active-shot caps remain unchanged.

Distance-based shot limits remain unchanged. Satellite and reflection age guards,
and the human-shot wall-clock fallback, increase inversely with the motion scale
so reduced speed does not shorten their travel distance. Shots can remain in
flight longer and occupy an existing active-shot slot longer. This is a gameplay
tradeoff, not a rendering optimization; the fixed rendering comparison excludes
it. No server protocol or deployment configuration changes are needed, but the
shared/server tuning requires a Railway deployment as well as the client release.

The production graphics preset remains native/full. The DPR 2 default is a
separate proposed sharpness tradeoff; it has not been adopted or physically
validated in this change. The existing diagnostic controls remain available.

## Verification

The checks below cover the original `771acd9` implementation. The subsequent
integration at `5d27a1a` preserves the current ring-fire, Quake, Harpoon and
authoritative-motion behavior. Sling/reel speed, reel acceleration and the
stronger Quake impulse also use the motion scale; the Harpoon interception
horizon increases inversely to preserve its reachable targets. The manual now
uses CMS Markdown and generated facts in `src/wiki/gameReference.ts`.
Integrated validation is recorded separately below.

- Fresh pinned dependencies installed with `npm ci`. The first browser batch
  passed seven gameplay/collector checks but failed the Wiki because a reused
  installation lacked ECharts. The complete affected batch passed after install.
- Both independent reviewers accepted the rendering and gameplay changes. The
  renderer review noted optional additional direct helper coverage; existing
  painter tests, alternate-quality browser checks and the three exact-pixel
  fixtures cover this small path-reuse change without another duplicate test.
- Ten focused movement, EO projectile, and graphics unit tests passed.
- The first full gate found two stale-speed fixtures: a crossing target faster
  than its intercepting laser, and a guest movement beyond the new server
  allowance. Both setups now use reachable motion, preserving their assertions;
  the guest scenario also verifies that the clock continues after disconnect.
  The 17 tests in those two files passed, and the independent reviewer accepted
  the corrections. The repeated full `npm run gate` passed, including the
  complete unit suite, lint, unused-code checks, runner contracts, both
  TypeScript checks, Wiki source review, and production build. No tests were
  skipped or excluded from the unit suite.
- All 52 tests in the full server/entity integration suites and affected browser
  files passed through `scripts/test-runner.sh`. Coverage includes simultaneous
  touch steering/fire, shield/ability feedback, rotation and cancellation, real
  freeze/resume and socket reconnect, two-player shot consistency/expiry, and
  desktop/mobile Wiki navigation and demonstrations.
- All 13 manual GIFs and posters regenerated deterministically and passed
  `wiki:media:check`. The ten changed posters were visually inspected.
- Desktop and mobile gameplay captures preserve readable ships, shots, shields,
  HUD and touch controls. The final successful browser scenarios report no new
  warnings or errors. Screenshots are retained under
  `tests/integration/browser/screenshots/`, including
  `slower-projectiles-desktop.png`, `performance-mobile-portrait.png`,
  `performance-mobile-landscape.png`, and the Wiki captures.
- The initial frame-work reports used a reused dependency tree. They remain in
  `.performance/path-before-install/`; the published work receipt uses the
  repeated observations after the fresh pinned dependency installation.

## Current-main integration verification

The implementation is now based on `5d27a1adf12777f9a36ba9b7f1751b17a23bdda8`.
The fresh gameplay review accepted the integrated motion values, preserved
weapon ranges and authority rules. The initial ability batch exposed 13
old-speed assertions; after correcting their setups, all 64 scenarios passed.

The selected server/entity/browser batch passed 56 of 58 scenarios initially.
The two failures were a health-recovery fixture firing beyond the new valid
speed envelope and an outdated capitalization assertion in the CMS manual test.
Both passed their focused rerun without weakening the gameplay assertions.
The full gate then passed after correcting two more old-speed shots in the
canonical ice-asteroid socket test. That test also now requires an admitted
server laser before resolving the actual hit; all seven scenarios in its file
passed. The independent reviewer accepted this correction. The full unit suite
ran without skips or exclusions, and the gate completed lint, unused-code,
runner, TypeScript, Wiki and production-build checks.

All 13 manual demonstrations regenerated and passed byte-for-byte reproduction.
The ten changed posters and desktop/mobile manual captures were inspected.
An observed portrait pickup-notice overlap was fixed by placing touch notices
below the leaderboard and fuel indicator. The four HUD layout tests passed,
and the sustained mobile-control scenario passed again with a deterministic
notice for portrait/landscape visual inspection. That notice setup proves
layout only; it does not stand in for a collected pickup. Browser checks cover
real steering/firing, cancellation, rotation, freeze/reconnect, two-player
shots, current abilities and manual navigation.

Logs are retained in `.performance/integration/`, including the initial failures,
focused reruns, `gate-final.log`, media checks and the Wiki source-review receipt.

No changes have been pushed or deployed. Physical-phone smoothness, battery and
thermal behavior remain unmeasured. The exploratory resolution runs do not close
those acceptance questions.
