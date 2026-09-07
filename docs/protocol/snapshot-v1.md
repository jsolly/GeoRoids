# Negotiated snapshots v1

Replacement for reverted #450/#466. Legacy clients continue receiving the exact
`{type:"gameState",data:<full public state>,timestamp}` envelope. There is no
implicit version detection and no lean variant of `gameState`.

## Deployment and rollback

The client offer is **off by default**. Build with `VITE_SNAPSHOT_PROTOCOL=1` to
include `snapshotVersion:1` in the join data. Unset it or set `0` to disable it.
An old server ignores this extra join field: unless its `joined.data` explicitly
confirms `snapshotVersion:1`, the new client continues the legacy path.

1. Merge supporting code with the offer disabled. Deploy the exact merged server
   on Railway, verify `/health` and its `x-release-id` and exercise a legacy client.
2. Enable the Vercel client offer in a separate change/deployment. Verify Vercel
   READY, both release headers, real two-player state, reconnect and effect clears.
3. For rollback, deploy a client with its offer disabled first. Legacy support
   remains on the server; then roll back the server if necessary. Already open
   negotiated clients must reload/reconnect before removing supporting servers.

Never deploy a client that assumes support before the server confirms it.

## Wire contract

The new envelope is `{type:"snapshot",data:<frame>,timestamp}`. A frame carries
`version:1`, positive integer `sequence`, and either:

- `kind:"keyframe", state:<complete ServerGameSnapshot>`.
- `kind:"delta", baseline:<previous sequence>, patch:{set,clear,collections}`.

Top-level `set` replaces a value, including nested arrays/objects. `clear` deletes
named optional fields. An omitted field is unchanged. Collection patches contain
`add` (full rows), `update` (`[id,set,clear]` tuples), `remove` (IDs), and optional
`order` (complete ID order when membership/order changes). Empty arrays are
complete empty collections. Removed bots/remotes, asteroids, loot, EO satellites, projectiles and pickups disappear.
Decoded harpoon expiry clears both target and cached latch position, including
on the predicting local ship.

The codec preserves all public JSON fields recursively. It does not whitelist
ship or asteroid fields; future keyed arrays automatically participate in delta
encoding and other fields replace safely. Exhaustive shared DTO validator maps
make additions to the shared world/entity/asteroid/loot/EO/pickup/projectile/tag DTOs
require corresponding validation. `ServerGameSnapshot` extends the unchanged
legacy `ServerGameState` with `satelliteProjectiles` and `collabTags`; these arrays
appear only in negotiated snapshots. Projectile IDs equal their stable `shotId`,
so an event and subsequent keyframe repair one shot instead of creating two.
Tags include asteroid ID, shooter hit records and expiry. Keyframes restore active
shots and cooperative windows after reconnect without replaying old events.
All six EO types, fire patterns, Echo/Relay ownership and shield duration, asteroid
shape/material/health, kits, factions and E/F timers use the shared DTO contract. Public state must be finite JSON;
unsupported values fail loudly and close the negotiated socket instead of
silently dropping state. Unknown valid JSON fields remain intact.

## Baselines and recovery

Baselines are keyed by actual sockets in a WeakMap. Join/rejoin replaces the
entry; reconnect starts at sequence 1. An old asynchronous callback cannot update
a replacement entry. The first state is full, at most 90 deltas follow a keyframe,
and a full frame replaces any delta that would be larger.

Baselines advance only in a successful WebSocket send callback. This acknowledges
the local transport write, **not remote application receipt**. WebSocket ordering
plus client sequence validation protects that distinction. Pending writes,
backpressure above 256 KiB, or failed writes force the next send to be full.
Excluded recipients keep their own baseline. One detached canonical world is
shared across recipients; no baseline points at mutable game engine state.

The production `ConnectionManager` invokes `SnapshotDecoder` before normal state
application. Deltas require both the exact baseline and consecutive sequence.
Stale frames, missing baselines, invalid shapes, conflicting edits, duplicate
IDs and unsafe object keys are rejected atomically. The previous state remains
visible; the client coalesces `snapshotResync` requests until a valid frame arrives.
The server schedules a keyframe on its normal broadcast cadence. Periodic frames
also repair a lost resync request. Unnegotiated snapshots close with protocol error.

## Verification

Run from `/Users/johnsolly/code/GeoRoids-protocol` (or the integrated checkout):

```sh
npx vitest run tests/unit/network/pilots-recover-complete-snapshots.test.ts tests/unit/network/old-and-new-pilots-share-a-server.test.ts tests/unit/network/runtime-client-negotiates-and-recovers.test.ts
node --expose-gc --import tsx scripts/benchmark-snapshots.ts
```

The runtime tests enter through the actual WebSocket `onmessage` callback; they
verify real entity/loot managers, malformed-frame preservation, asteroid removals,
harpoon unlatch, legacy fallback, rejoin, EO shot dedupe/death, pickup ownership,
and asteroid metadata/tag clearing. Run the real socket test through the serialized
integration runner:

```sh
./scripts/test-runner.sh tests/integration/server/mixed-version-pilots-recover-after-reconnect.test.ts
```

The benchmark uses 10 moving ships, 80 shaped moving asteroids, 15 drops, six EO
satellites, two pickups, and 0–6 active projectiles. It compares exact current
legacy full JSON, semantically complete full JSON (including recovery arrays), and
negotiated encode/decode work, bytes, sampled heap growth and retained heap after GC;
heap deltas are noisy process observations, not exact allocation counts.

### Integrated measurement (2026-09-07)

Node 24, 900 ticks, forced GC between warmed runs, the complete fixture above:

| Measurement | Legacy full JSON | Complete full JSON | Negotiated v1 |
| --- | ---: | ---: | ---: |
| Bytes per tick | 31,450 | 32,057 | 8,046 |
| Encode + parse/decode ms per tick | 0.165 | 0.167 | 0.917 |
| Sampled heap growth bytes | 33,269,120 | 33,278,120 | 33,051,200 |
| Retained heap after GC bytes | -21,024 | 35,304 | 203,384 |

This is a **74.4% reduction versus the current legacy wire**, and 74.9% versus
semantically complete full JSON. It adds 0.752 ms of total encode/decode work per
tick and retains a decoder baseline. This is a bandwidth improvement with a CPU
and memory cost; it is not an allocation improvement. Negative retained heap in
the legacy run reflects GC noise, not negative allocation. Sampling does not
count individual allocations, and high-water measurements depend on GC timing.

The decoder retains one detached baseline and returns the application-owned
reconstructed state; a redundant full clone was removed after initial profiling.
Server capture is shared once per broadcast. This single-client encode/decode
benchmark does not claim multi-client server scaling or phone-frame-rate proof.
