# Negotiated snapshots v1

Replacement for reverted #450/#466. Legacy clients continue receiving the exact
`{type:"gameState",data:<full public state>,timestamp}` envelope. There is no
implicit version detection and no lean variant of `gameState`.

## Deployment and rollback

The client offer is **on by default**, after the supporting server deployment.
An unset `VITE_SNAPSHOT_PROTOCOL` or explicit `1` includes `snapshotVersion:1` in
the join data. Build with `VITE_SNAPSHOT_PROTOCOL=0` to disable the offer; changing
the build setting requires a new client deployment.
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
Acknowledged harpoon expiry clears both target and cached latch position,
including on the predicting local ship. An unacknowledged local Hauler prediction
may survive a brief reconnect only for its remaining, locally ticking lifetime
while its target still exists. Acknowledged expiry, target removal, death or
natural timer expiry clears it. Reconnect neither extends that timer nor replays
an ability request; this prediction does not restore server ability state.

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
entry; reconnect starts at sequence 1. During a same-socket rejoin, the client
continues decoding the old session until the ordered `joined` acknowledgment,
so snapshots already in flight do not trigger a false protocol error. An old
asynchronous callback cannot update a replacement entry. The first state is full, at most 90 deltas follow a keyframe,
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

Run from `/Users/johnsolly/code/GeoRoids` (or the integrated checkout):

```sh
npx vitest run tests/unit/network/pilots-recover-complete-snapshots.test.ts tests/unit/network/old-and-new-pilots-share-a-server.test.ts tests/unit/network/runtime-client-negotiates-and-recovers.test.ts
npm run benchmark -- measure codec --revision HEAD --seed 42
npm run benchmark -- measure transport --revision HEAD --seed 42
```

The complete command and artifact contract is in the
[benchmark framework guide](../../benchmarks/README.md). A benchmark checkout
must be clean and committed. Each requested revision is archived and receives
the same benchmark code overlay, with dependency and before/after source hashes
recorded. Transport is a single-revision realtime sample; compare client, server
or codec with `npm run benchmark -- compare KIND --baseline REV --candidate REV`.

The runtime tests enter through the actual WebSocket `onmessage` callback; they
verify real entity/loot managers, malformed-frame preservation, asteroid removals,
harpoon unlatch, legacy fallback, rejoin, EO shot dedupe/death, pickup ownership,
and asteroid metadata/tag clearing. Run the real socket test through the serialized
integration runner:

```sh
./scripts/test-runner.sh tests/integration/server/mixed-version-pilots-recover-after-reconnect.test.ts
```

The current codec measurement uses the original seeded snapshot fixtures and
checks every decoded keyframe and delta against its original fixture state. It
exercises shared and staggered recipient baselines at 1, 2, 5, 10 and 25
recipients. Encode/serialize and decode timings are separate. Reported bytes are
UTF-8 application payload bytes from the JSON snapshot envelope, not WebSocket
transport framing. The transport measurement uses two real loopback clients and
an owned child server; its native scheduling is nondeterministic and its server
seed belongs to the server factory. The direct server runner uses two loopback
humans and two seeded engine-created bots.

These measurements describe a fixture and its machine. They do not establish an
optimization result, a supported device or a supported server capacity.

### Archived fixture measurements (2026-09-07)

The table below is retained from the retired snapshot script at the recorded
revision [`54d8c18`](https://github.com/jsolly/GeoRoids/blob/54d8c18d4ce25b3ea6af731582bd615666761a85/scripts/benchmark-snapshots.ts).
It is historical evidence, not output from the current runner. Node 24, 900
ticks, forced GC between warmed runs, and the complete fixture used at that time:

| Measurement | Legacy full JSON | Complete full JSON | Negotiated v1 |
| --- | ---: | ---: | ---: |
| Bytes per tick | 31,450 | 32,057 | 8,046 |
| Encode + parse/decode ms per tick | 0.165 | 0.167 | 0.917 |
| Sampled heap growth bytes | 33,269,120 | 33,278,120 | 33,051,200 |
| Retained heap after GC bytes | -21,024 | 35,304 | 203,384 |

That archived run measured 74.4% fewer bytes than its legacy fixture and 74.9%
fewer than its semantically complete full-JSON fixture. It also measured 0.752 ms
more total encode/decode work per tick and retained a decoder baseline. These
percentages describe that old comparison only. Negative retained heap in the
legacy run reflects GC noise, not negative allocation. Sampling does not count
individual allocations, and high-water measurements depend on GC timing.

The decoder retains one detached baseline and returns the application-owned
reconstructed state; a redundant full clone was removed after initial profiling.
Server capture is shared once per broadcast. This single-client encode/decode
measurement does not establish multi-client scaling or phone frame rate.

### Archived shared broadcast work (2026-09-08)

The archived comparison at [`c60859d`](https://github.com/jsolly/GeoRoids/tree/c60859d)
measured an implementation where each broadcast owned one `SnapshotEncoder` per
capability view. The encoder
validates and detaches the current world once, then builds each patch once per
retained baseline state. Recipients still have independent sequence numbers,
backpressure, successful-send callbacks, and resync state. The callback retains
only the delivered state and frame; the encoder cache ends with the broadcast.

Frame selection counts the complete serialized metadata for each recipient,
including changes in sequence-number digits. A size tie sends a keyframe. The
comparison uses JavaScript string length, preserving the previous algorithm;
reported wire sizes use UTF-8 bytes.

A warmed, alternating comparison against the encoder at `c60859d` used 181 moving
worlds, seven samples per implementation, and staggered recipient sequences.
The timed work includes capture, encoding, final envelope serialization, and byte
counting. Decoder equality checks ran outside the timed region.

| Recipients | Previous ms/broadcast | Shared ms/broadcast |
| --- | ---: | ---: |
| 1 | 0.525 | 0.526 |
| 2 | 0.769 | 0.488 |
| 5 | 1.598 | 0.543 |
| 10 | 3.053 | 0.656 |
| 25 | 7.361 | 1.014 |

Wire bytes were identical at every recipient count. One-recipient timing was
within run-to-run variation; the archived ten-recipient sample measured about 79%
less preparation time. These are local synchronous CPU measurements, excluding
socket I/O and rendering. Most recipients in this comparison shared their
previous world. Clients stalled on different worlds need separate patches. The
current codec runner covers shared and staggered baselines, but it does not
recreate this archived table.

## Enhanced asteroid capability

An additive `asteroidInteractions:1` join offer requires snapshot v1 and an explicit
matching acknowledgment. The joined socket alone receives its private resume token.
A physical gameplay socket close gives that token a two-second neutral-input grace;
a same-socket rejoin is idempotent, a valid token can atomically supersede an old
socket, and expiry/leave/reset invalidates it. Ordinary legacy joins cannot acquire
constrained motion through an asteroid tool packet.

Optional asteroid `phenomenon` and `spinClass` metadata is preserved on
first creation and complete/delta updates. `playerProjectiles` carries stable
process-unique shot IDs, geometry, bounded fractional energy, bounce count and age.
The enhanced client reconciles keyed rows and ignores legacy shot events for bolt
creation. Reflection energy uses finite numbers in [0,8]; sequences, epochs and
bounce counters remain integers. Core upgrades carry bounded charges and expiry.

Enhanced Hauler poses use server motion epochs and monotonically increasing input
sequences. During latch/release/handoff, legacy movement packets cannot overwrite
position, velocity, fuel or spin. The client rebases each authoritative frame and
replays only its bounded unacknowledged input queue. A new handoff epoch/anchor and
reachable-pose acknowledgment are required before free prediction resumes. Server
time and kit speed bound all subsequent enhanced free poses.
