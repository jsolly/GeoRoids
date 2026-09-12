# MessagePack snapshot experiment, September 12, 2026

The [current-source P4 follow-up](current-binary-codec-results.md) closes the
previously open trial: its six primary CPU pairs exceed the fixed limit.
The measurements below predate the integrated P4 and owned-input decoder.

## Historical decision and open trial

The tested `@msgpack/msgpack@3.1.3` configuration increases total snapshot CPU
and independently deflated bytes. It is not a CPU optimization. It saves
16.2–16.4% of raw delta-stream bytes, which matters because production currently
sends uncompressed WebSocket messages. A bounded raw-wire transport/browser
trial remains feasible; offline results cannot decide whether bandwidth savings
outweigh CPU cost under congestion. No production dependency or protocol changed.
This result does not reject every binary format, schema or runtime alternative.

## Offline observations

Each row pools three rotated-order rounds of 180 measured frames per codec,
after 30 warmup frames per round. Both codecs use the real SnapshotEncoder and
SnapshotDecoder. Values are JSON → exact compact-integer MessagePack.
The delta-stream rows include a scheduled keyframe every 90 frames; byte savings
are means for that mixed stream, not pure delta frames.

| History / stream | Pipeline p50 | Pipeline p95 | Mean raw bytes | Mean deflated bytes |
| --- | ---: | ---: | ---: | ---: |
| Moving / deltas | 0.772 → 0.829 ms | 1.032 → 1.109 ms | 8,451 → 7,067 | 1,305 → 1,482 |
| Moving / keyframes | 0.535 → 0.698 ms | 0.670 → 0.892 ms | 32,761 → 31,207 | 2,562 → 2,839 |
| Churn / deltas | 0.729 → 0.773 ms | 0.910 → 0.957 ms | 8,256 → 6,916 | 1,293 → 1,470 |
| Churn / keyframes | 0.509 → 0.660 ms | 0.591 → 0.838 ms | 31,093 → 29,579 | 2,463 → 2,734 |

Delta pipeline medians increased 6.0–7.4%, with a regression in every round.
Faster decoding/application did not offset encoding. Keyframe pipeline medians
increased about 30%. An earlier float64-only configuration was also slower and
produced larger deflated payloads; its separate raw samples remain.

The pipeline includes capture, diff, JSON-based patch/keyframe selection,
serialization/deserialization, validation, application and retained baseline.
It excludes browser entity/HUD application, transport and rendering. Compression
uses per-message raw DEFLATE at level 6/window 15 without context reuse. These
compressed sizes are hypothetical, not observed wire bytes.

Histories are synthetic: ten human/bot rows, up to 80 asteroids, 15 loot drops,
six satellites, two pickups and two to four player shots. They are not production
replays or phone measurements. Both short batches completed in quiet windows
with successful exit status and raw samples retained.

## Correctness and provenance

All 840 produced frames passed 3,360 exact codec round trips. Probes cover
collection changes/order/clears, Unicode, malformed UTF-16, numeric extremes,
signed zero, invalid baselines and truncated-message recovery. Native MessagePack
changes long lone-surrogate strings that the actual join decoder accepts. The
exact candidate uses a copy-on-change adapter with UTF-16 and signed-zero
extensions. Malformed object keys fail closed; protocol keys are authored.
Current JSON normalizes negative zero, and snapshot equality treats a zero-sign
change as unchanged. Timing histories contain no negative zero; exactness for
that edge case is tested separately.

Independent review accepted correctness and stage boundaries. It required
narrowing the original rejection because raw-byte savings remain relevant to
uncompressed transport. The retained summary generator and checksum manifest
now reproduce both summaries. Pooled p50 averages the middle two samples;
original per-round p50 uses the lower middle. The largest convention difference
is 0.000292 ms and does not change the conclusion.

The [receipt](binary-codec-receipt.json) identifies detached `5d27a1a` source,
pinned package lock, scripts, raw samples and summaries under
`/Users/johnsolly/code/GeoRoids-worktrees/binary-codec-experiment/.codec-lab/`.
A raw-wire trial must measure framing/bytes, server fanout CPU, browser binary
handling, decode and `applyReceivedSnapshot`, freshness and recovery with
equivalent workloads. Smaller payloads alone cannot establish a phone/GPU gain.

Primary references: the
[pinned encoder](https://github.com/msgpack/msgpack-javascript/blob/v3.1.3/src/Encoder.ts),
[UTF-8 implementation](https://github.com/msgpack/msgpack-javascript/blob/v3.1.3/src/utils/utf8.ts)
and [ws compression documentation](https://github.com/websockets/ws#websocket-compression).
