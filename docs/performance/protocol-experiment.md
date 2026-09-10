# Protocol and compression experiment

This is a diagnostic benchmark for the existing snapshot protocol. It compares
the full legacy `gameState` JSON envelope with a snapshot-v1 keyframe and the
actual snapshot-v1 delta selected by `SnapshotEncoder`. It does not change a
wire default or enable compression in production.

Run it from `/Users/johnsolly/.codex/worktrees/georoids-performance` with:

```sh
npx tsx benchmarks/protocol-experiment.ts --seed 42 --warmup 30 --ticks 120
```

The executable returns the shared `Measurement` shape as JSON. It reuses
`tests/unit/network/snapshotFixture.ts` (10 entities, 80 asteroids, loot,
satellites, pickups, and collaboration tags) and adds a representative
four-row active `playerProjectiles` collection, then warms up 30 evolving
worlds and measures 120 worlds. Every decoded payload is compared with its
source world, including DTO validation for legacy packets. All encode, decode and
compression paths execute during warmup; gzip/deflate round trips are checked
outside the timing intervals. The delta path is required to produce a real delta after the
initial keyframe.

Sizes use `Buffer.byteLength(payload, 'utf8')`, including the JSON envelope and
excluding WebSocket framing. The benchmark also records synchronous
`node:zlib` gzip and deflate sizes and CPU time over those UTF-8 bytes. Those
compression samples describe codec work only; they are not measurements of
`ws` per-message-deflate latency, memory, negotiation, or network behavior.

## Local evidence

Evidence below came from one run on 2026-09-09 in the dirty implementation worktree based on `10baef5`, using Node
`v24.16.0` on Darwin arm64. Means are per measured payload; timings are
descriptive and machine dependent.

| Variant | UTF-8 bytes | gzip bytes | deflate bytes | encode + JSON (ms) | JSON/protocol decode (ms) | gzip (ms) | deflate (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy full JSON | 32,723.01 | 2,555.13 | 2,543.13 | 0.0868 | 0.1768 | 0.1758 | 0.1587 |
| Snapshot keyframe | 32,776.43 | 2,588.17 | 2,576.17 | 0.2264 | 0.3519 | 0.1671 | 0.1535 |
| Snapshot delta | 8,166.60 | 1,301.99 | 1,289.99 | 0.4967 | 0.3402 | 0.0547 | 0.0439 |

The negotiated delta reduced uncompressed payload bytes by 75.04% versus the
legacy payload in this fixture. Pilot names include Japanese characters, Greek
letters and emoji in the actual encoded worlds. All decoding and compression
round trips preserve those names. The additional Unicode probe `🛰️ Δ`
was counted as 10 UTF-8 bytes.

## Decision

The existing negotiated JSON delta path is supported by this measurement: it
cuts payload bytes materially while retaining the current validation and
keyframe recovery behavior. Keyframes are approximately the same size as
legacy JSON. This experiment does not justify a binary protocol or interest
management change because it measures no end-to-end latency or server work for
those alternatives.

Production compression stays off. Synchronous gzip/deflate costs are small for
the sampled payloads, but this run has one process, one fixture stream, no
concurrent recipients, and no RSS or stalled-socket observation. A production
compression decision needs a separate concurrency test with `ws` negotiation,
phone decode time, memory, CPU, and outbound pressure. The output also omits
WebSocket framing and transport latency, so compressed byte totals are not
bandwidth or capacity claims.

Raw samples from this local diagnostic are retained at
`.performance/protocol-experiment.json` in the implementation worktree.
