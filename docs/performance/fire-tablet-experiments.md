# Fire HD 10 measurement record

The target remains sustained 60 FPS on the Fire HD 10, 13th generation.
The unmerged direct-GPU experiment in PR #854 was retired on October 20, 2026.

## Historical capture

The reported release `7c30592ef940793e7d717115df5f8bbdc6f3bf4e` capture used a
`KFTUWI` tablet, Chrome 152 on Android 11, an 800 by 1094 CSS viewport, native
DPR 1.5, a 1200 by 1641 backing canvas, and full glow. Its old HUD estimate was
8 FPS. The 138 cached asteroids did not establish the visible draw count, and
the 8 ms snapshot age measured time since local application, not server-to-screen
delay. A single capture does not identify the bottleneck.

The revised HUD counts frames over bounded elapsed foreground time, including
long stalls, instead of smoothing reciprocal intervals and dropping stalls over
250 ms. Use recorder exports for comparisons rather than one HUD number.

## Shipped Scan behavior

[PR #855](https://github.com/jsolly/GeoRoids/pull/855) shipped direct simplified
Scan rendering at `63fd9f754c072ae4cbf956448c83a8b8471dce97`. Low-end device
policy selects the simpler view, which paints live terrain, ships, hazards and
navigation into the bounded visible canvas and restores flight resolution
afterward. Scan uses at most DPR 0.75, one million backing pixels, and a
1536-pixel maximum dimension. The [quality policy](mobile-quality-decisions.md)
defines activation and diagnostic controls.

## Short physical-device result

A complete 53.0549-second Fire recording on the reviewed PR #855 preview measured
about 59.1 FPS in flight and 59.1 FPS across 8.482 seconds of Scan intervals,
including entry, wide view and return. It used Canvas, native-resolution flight
at 1200 by 1641, simplified Scan at 600 by 820, and the diagnostic glow-off
setting. This result does not qualify ordinary full-glow play.

Report `735d2e33-a926-4fe6-93e1-9db500ec4530` contains 3,135 completed frame
intervals, including 501 Scan intervals. Its reconstructed report SHA-256 is
`f92a64697076c16e3f9ffea6d8cd955e3761f91666ed12ef51af8834086e81ce`.
The preview head was `a8a6f60ae979ce5972a91ed2a506644ef645509d`; its runtime
release token was `b0003527e3fe57a90ec7665faa1038af4e13639b`.
The [production receipt](https://github.com/jsolly/GeoRoids/pull/855#issuecomment-6302251345)
records the release separately from the measurement limits.

The run was short and exploratory, with occasional slow intervals. The uploaded
bundle contains summary percentiles rather than the original full interval
series; unmatched manual scenes cannot establish a controlled causal speedup.
Sustained, thermal, battery, full-glow and GPU performance remain unqualified.
John waived the longer test as a shipping condition; it was not performed or
passed.

## Retired direct-GPU experiment

[PR #854](https://github.com/jsolly/GeoRoids/pull/854) tested direct GPU background
composition and a GPU terrain path. John retired it without merging after the
Fire tablet comparisons showed no advantage over Canvas. This retires that
prototype; the earlier optional WebGL2 renderer and shared measurement tools
already on main remain available.

The first short comparison measured about 57.8 FPS in Canvas flight and 28.9 FPS
in direct-GPU flight. Both used native DPR 1.5 and glow off, with forced full-detail
Scan; their tiny Scan samples cannot establish a useful Scan comparison.

A later three-arm comparison used the same preview build, native DPR 1.5, glow
off, an 800 by 1094 CSS viewport and 1200 by 1641 flight backing canvas. All arms
used automatic simplified Scan:

| Arm | Recorded seconds | Flight FPS | Flight p95 / p99 interval, ms | Scan FPS |
| --- | ---: | ---: | ---: | ---: |
| A: Canvas | 40.65 | 59.58 | 16.8 / 16.9 | 40.24 |
| B: direct GPU with GPU terrain | 44.21 | 28.41 | 50.0 / 66.7 | 38.22 |
| C: GPU background and stars, Canvas terrain | 51.70 | 59.62 | 16.8 / 17.2 | 40.21 |

Keeping terrain on Canvas recovered flight cadence but did not demonstrate an
improvement over Canvas. The GPU arms used Canvas intentionally during simplified
Scan; their recorded Canvas frame counts matched those Scan intervals. Scan
still ran around 38 to 40 FPS in this matrix, before the separate PR #855 change.

FPS here is completed animation-frame intervals divided by total foreground seconds,
not measured GPU execution or guaranteed display presentation. These were short,
sequential manual runs with different scenes and unequal durations; power and
temperature were uncontrolled, and sustained acceptance was not completed.
They support retiring this candidate on this tablet, not a universal GPU verdict.

The matrix source head was `09322a61678ae3bbeda3a03bf2cf25dd7f2c9b3f`; its preview
client release identifier was `698b02474f517360232e6ee42c705fd899aaa349`. The
[retirement receipt](fire-tablet-gpu-retirement-receipt.json) lists the exact
retained report and arithmetic locations, byte sizes and SHA-256 checksums.
No GPU testing handoff remains open.

## Emulated cohort for this geometry

`benchmarks/realtime-client.ts` carries a `fire-hd-10` viewport cohort that
reproduces this record's geometry: an 800 by 1094 CSS viewport pinned to device
DPR 1.5, which is the 1200 by 1641 flight backing canvas every capture above
used. The cohort pins that DPR instead of taking `--dpr`, and the harness
refuses to start when the pinned DPR and viewport stop multiplying out to that
backing canvas, so the cohort cannot drift away from this record unnoticed.

```sh
npm run benchmark:realtime -- --viewport fire-hd-10 --scenario combat --seed 42 --warmup 30 --seconds 180 --output .performance/fire-hd-10.json
```

Geometry is all it reproduces. No CPU slowdown is pinned, because none has been
calibrated against this tablet; choose `--cpu-slowdown` deliberately and read the
runbook's lanes as stress settings rather than a model of this device. Isolate
flight pixel cost with `--render-dpr`, as the caps below describe, rather than
`--dpr`, which this cohort rejects. Emulation still does not reproduce this
tablet's GPU, thermal or sustained behavior, so a clean cohort run narrows where
frame cost arises at the device's real resolution and qualifies nothing. Every
gap this record lists stays open.

## Optional future comparisons

For any future authorized device comparison, follow the
[measurement runbook](mobile-measurement-runbook.md). Caps 2 and 1.5 do not lower
flight resolution on this native-DPR-1.5 tablet; cap 1 can isolate flight pixel
cost. Compare resolution and glow independently, and record Scan mode and actual
backing dimensions separately. These are optional experiments, not an active
testing handoff or a continuation of the retired GPU work.
