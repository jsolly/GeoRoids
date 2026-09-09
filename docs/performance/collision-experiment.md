# Circle collision index experiment — September 9, 2026

Decision: reject this grid implementation for production. It preserved collision
outcomes but cost substantially more than the existing loops in every fixture.
This does not rule out a different index at a measured larger workload.

Run from `/Users/johnsolly/.codex/worktrees/georoids-performance`:

```sh
NODE_ENV=production npx --no-install tsx benchmarks/collision-experiment.ts .performance/collision-experiment.json
```

The experiment uses seed 42, 80 asteroids, 100 worlds per row, 128-unit cells,
large circles spanning multiple cells, and immune pilots. All 800 worlds matched
both first-asteroid hit priority and ship-pair ordering. Twelve timing batches
alternate baseline/candidate order. These are medians of batch means in
milliseconds per world, not server tick percentiles. Shared-host scheduling and
lack of A/A calibration limit conclusions about small timing differences.

| Pilots | Scene span | Existing loops ms | Grid ms | Grid / existing |
| --- | --- | --- | --- | --- |
| 3 | 2000 | 0.000419 | 0.029403 | 70.2× |
| 12 | 2000 | 0.001146 | 0.036278 | 31.7× |
| 27 | 2000 | 0.002614 | 0.058357 | 22.3× |
| 52 | 2000 | 0.006446 | 0.083110 | 12.9× |
| 3 | 200 | 0.000068 | 0.023193 | 342.5× |
| 12 | 200 | 0.000377 | 0.056357 | 149.6× |
| 27 | 200 | 0.002154 | 0.150289 | 69.8× |
| 52 | 200 | 0.008601 | 0.309918 | 36.0× |

Index construction, string cell keys, candidate deduplication and priority sorting
are included. Swept projectiles are unchanged and excluded. The experiment adds
no production collision code, does not measure server capacity, and makes no
claim about physical-device performance. Candidate indexing is only worth
revisiting if real server profiles show the existing circle loops dominating.

The raw diagnostic output is in `.performance/collision-experiment.json` in the
implementation worktree. The executable fixture is retained in `benchmarks/`; the raw local
report is ignored alongside other machine-specific observations.
