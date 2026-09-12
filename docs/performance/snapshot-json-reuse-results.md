# Reusing serialized snapshot payloads

The snapshot encoder already serialized full state and patches to choose the
smaller frame. The broadcaster then serialized that same payload again for each
recipient. The candidate retains those strings within the broadcast's encoder
and combines them with each recipient's small metadata envelope.

Each broadcast owns a new encoder. Its strings and patch map have the same
lifetime as that detached world; there is no history cache. Each recipient still
has its own sequence, baseline and keyframe recovery. The wire format, property
order, selected frame and exact payload bytes are unchanged.

## Measured serialization work

The comparison uses the original encoder from base commit `5d27a1a` plus its
original envelope serialization against the actual `encodeSerialized` API used
by `GameStateBroadcaster`. It runs Node 24.16.0 on the local Apple silicon Mac,
with the snapshot fixture's ten pilots, 80 asteroids and satellite world.

Each scenario has 30 warmup ticks and 120 measured ticks. Three A/A controls and
three alternating A/B comparisons cover shared recipient baselines and staggered
delivery, where one fifth of recipients miss each tick. This fixture measures
encode and serialization work for all recipients. Encoder construction, world
capture, socket scheduling and network drain are outside that timed region.

| Baselines | Recipients | Original ms/tick | Candidate ms/tick | Reduction | Largest A/A drift |
| --- | ---: | ---: | ---: | ---: | ---: |
| Shared | 1 | 0.3038 | 0.2893 | 4.75% | 2.72% |
| Shared | 5 | 0.3999 | 0.2965 | 25.85% | 2.75% |
| Shared | 10 | 0.5159 | 0.3042 | 41.03% | 1.99% |
| Shared | 25 | 0.8678 | 0.3284 | 62.16% | 1.13% |
| Staggered | 1 | 0.2395 | 0.2275 | 5.03% | 0.76% |
| Staggered | 5 | 0.5706 | 0.4815 | 15.63% | 3.33% |
| Staggered | 10 | 0.6642 | 0.4864 | 26.77% | 2.84% |
| Staggered | 25 | 0.9486 | 0.5098 | 46.26% | 31.41% |

The single-recipient benefit is small. The 25-recipient staggered control includes
a large cold outlier; its three measured A/B batches consistently improved by
about 45.8–47.1%. These results establish phase CPU savings, not a supported player
count or phone FPS improvement.

## Exactness and review

The retained verification compares wire text, decoded worlds and frame selection,
including metadata digit changes and size ties. It covers staggered baselines,
delayed send callbacks, pressure skips, errors and keyframe recovery. Source and
consumer mutations cannot alter retained baselines. Numeric and escaped-string
cases preserve the original JSON behavior.

The two focused encoder/broadcaster test files passed all 23 scenarios, and
TypeScript passed. Independent review accepted the actual production changes,
raw paired samples and lifecycle evidence. Combined desktop/mobile gameplay and Wiki browser checks, 61 focused scenarios
and the full repository gate passed for the combined candidate.

No Wiki behavior or illustration changes are needed for serialization reuse.
Snapshots carry the same state at the same cadence.

## Evidence and reproduction

The [receipt](snapshot-json-reuse-receipt.json) identifies source and raw artifacts.
Local ignored evidence is in `.performance/snapshot-json-reuse/final/`. Earlier
wrapper prototypes remain separate and are not the measured production candidate.

The measured encoder SHA-256 starts `96bcf7b9`; the currently formatted source
starts `fc27b683`. `measuredSnapshotProtocol.ts` retains the measured source.
`format-equivalence.json` proves that reversing one ternary line wrap reconstructs
its exact hash. Original timing metadata remains unchanged; the formatting
difference does not change the tested implementation.

From `/Users/johnsolly/code/GeoRoids-worktrees/mobile-performance-and-pace`:

```sh
node --import tsx .performance/snapshot-json-reuse/final/final-benchmark.ts \
  --mode verify --output .performance/snapshot-json-reuse/final/recheck.json
```

Timing mode requires the harness's `SNAPSHOT_JSON_REUSE_TIMING_APPROVED=1` quiet-host
guard and `--mode batches`. Retain a new output path when reproducing a run;
do not overwrite the original receipt.
