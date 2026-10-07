# Snapshots v2

Gameplay uses snapshot v2 with reflective asteroid support. Every join must offer
`snapshotVersion:2` and `asteroidInteractions:1`; the server acknowledges both
and provides a private resume token before the client starts play. Missing or
unsupported capabilities fail explicitly. There is no full-state `gameState`
transport, disabled-offer build, or legacy-client mode.

## Deployment

Merge through the CI-gated PR flow. Vercel publishes the client through Git and
Railway publishes the server independently. Version 2 is a clean break: no
version-1 decoder, negotiation bridge, rollout flag or protocol rollback mode
remains. World persistence, diagnostic log envelopes and player-motion epochs
keep their existing schemas.

Publish the matching client and server revisions close together. Either deployment
order has a temporary mismatch window: a version-1 tab cannot join a version-2
server, and a version-2 client cannot join a version-1 server. Refreshing obtains
the current client; it cannot finish a pending server deployment. Existing tabs
must refresh when requested. A version mismatch fails explicitly rather than
starting gameplay with incomplete or incompatible state.

Gameplay WebSocket URLs must include `snapshotVersion=2` and
`asteroidInteractions=1`. Missing or unsupported offers receive HTTP 426 before
upgrade. The join message is validated again, so URL parameters alone do not
grant access. The client rejects an unsupported server acknowledgment. The log
WebSocket remains a separate version-1 diagnostic protocol.

Verify the actual client and server release IDs after both hosts publish, then
prove two-player snapshots, movement, accepted firing and private-token reconnect
through the canonical production smoke. One host's successful deployment cannot
prove that the other published. See [release operations](../agent-operations.md#deploy).

Player rows carry `contourLock: {height, direction}` while following a contour.
`height` is a fixed visible terrain level (a multiple of 0.08) and `direction` is
`1` or `-1`.
Omission means unlocked. Lock state is transient and is not persisted.

## Wire contract

The envelope is `{type:"snapshot",data:<frame>,timestamp}`. A frame carries
`version:2`, positive integer `sequence`, and either:

- `kind:"keyframe", state:<complete ServerGameSnapshot>`.
- `kind:"delta", baseline:<previous sequence>, patch:{set?,clear?,collections?,objects?}`.

Top-level `set` replaces a value; `clear` deletes named optional fields. An
omitted field is unchanged, and omitted operation lists are empty. Unknown
valid JSON fields still use ordinary replacement patches. Complete empty
arrays represent complete empty collections.

A keyed collection patch may contain `add` (complete rows), `update`, `motion`,
`remove` and `order`. Updates and removals address the zero-based row index in that
recipient's immediate baseline, rather than repeating the row ID. Explicit
`order` lists contain the complete resulting order: baseline indices refer
to surviving baseline rows, and `baseline.length + addIndex` refers to a newly
added row. Updates and removals cannot refer to additions. Without `order`, surviving baseline rows
retain their order and additions append in their offered order. References
expire on the next sequence; there is no retained ID dictionary or history.

General updates are `[baselineIndex,set,clear?]`. An asteroid update containing
only changed position, rotation or velocity may instead use
`[baselineIndex,mask,...values]`: bit 1 carries position x/y, bit 2 rotation,
and bit 4 velocity x/y, in that order. Without bit 8, values are absolute
selected-precision numbers. Bit 8 makes every offered component a signed safe
integer delta in four-decimal units (factor 10,000). It requires at least one
field bit; it never adds a component. The previous and current values must each
round-trip exactly through a safe scaled integer, and their difference must
also be safe. The encoder uses relative motion only when the complete tuple's
JSON UTF-8 byte size is strictly smaller, including the two-digit mask; ties
keep absolute motion. Other asteroid changes, including
optional field deletion, retain the general update shape.

Only `objects.spiderField` supports a nested object patch, with the same optional
`set`, `clear` and keyed `collections` operations for `spiders`, `nests` and
`consumed`. Spider motion-only updates use position bit 1 and angle bit 2;
bit 8 uses the same relative integer representation and exact size choice.
other changed fields retain general updates. Spider and nest membership,
order and unchanged fields survive exactly; the decoded application still
receives the complete `spiderField` DTO. No distant spider, discovered nest,
map knowledge or furnace pulse is dropped to reduce bytes.

`motion` is a canonical base64 stream of relative asteroid or spider updates.
Each record starts with an unsigned varint of `gap * 32 + mask`, where the gap
counts untouched baseline ordinals after the previous packed record, starting
at -1. Masks 9–15 retain the relative component order above; spiders permit
only 9–11. Signed safe integers use a sign bit and six magnitude bits in the
first byte, then seven magnitude bits per continuation byte. No integer is
doubled or truncated to 32 bits. EOF ends the stream. Generic and absolute
updates remain in `update`; one touched-row set rejects overlapping operations.

For asteroids only, mask bit 16 marks exact residuals against a compression
reference. The reference uses the accepted positive integer game-time difference,
the baseline velocity for position and angular velocity for rotation. Each
reference delta is `round((oldValue + rate * ticks) * 10000) - oldScaledValue`;
velocity reference deltas are zero. Every intermediate and reconstructed integer
must remain finite and safe. The decoder restores the actual relative deltas
before applying them; it never infers an unoffered simulation result. Invalid
contexts, extra baseline vector fields and unsafe arithmetic cannot use this
mode. A packed record uses prediction only if its complete byte length shrinks,
and a collection uses packing only if its entire JSON UTF-8 representation
shrinks. Base64 spelling, padding bits and shortest varints are validated before
bounded reconstruction; negative zero, truncation and overlong integers reject
the frame atomically.

Decoding requires the exact sequence/baseline, valid integer references,
unique touched rows, nonconflicting field operations, immutable row IDs and a
complete order permutation. Motion masks have fixed valid bits and exact tuple
lengths; numeric values must be finite. Relative deltas must be safe integers,
their corresponding baseline components must be exact P4 values with safe
scaled integers, and each integer sum must be safe. Decoding adds integers
first and divides by 10,000, never adding floating-point offsets. Non-P4 or
unsafe baselines, extra vector fields and larger relative tuples retain
absolute or general updates without losing fields. Existing safe-key, nesting and complete
DTO validation still apply. A malformed patch cannot mutate or advance the
retained baseline. The client requests a keyframe; a valid delta against the
unchanged baseline may still apply. Removed remotes,
asteroids, loot, EO satellites, projectiles and pickups disappear.

Hauler snapshots include optional `haulerUtility` (`resource_tap`,
`boost_coupling`, or `tow_cable`; missing means tow cable). Loot kind `tap` is a Resource Tap
canister. Harpoon attachments persist until release, delivery, target removal, death or
excessive cable separation. An explicit null target clears the client's cached
latch. Reconnection uses authoritative attachment state and never replays an
ability request.

Scout snapshots include optional `scoutUtility` (`mineral_scan` or
`survey_probe`; missing means mineral scan). Retired wire token `build_furnace`
still decodes and readers map it to mineral scan; `setScoutUtility` rejects
it. Near a dark furnace lot within approach range, `useAbility` builds that
furnace instead of launching the equipped scan or probe. Clients never submit a
probe pose, target, health, or expiry.
An asteroid's optional `probe` stores its beacon ID, owner, health, maximum
health, attachment and expiry times in epoch milliseconds, and its local angle
and radial offset. The client derives the moving beacon pose from the host.
An explicit null or absence in a complete asteroid row clears the beacon.
The server owns attachment, damage, scan pulses, expiry, and replacement.

`civicModules` lists lit furnaces with `builderName` and an optional
`builderId`. That id is the public pilot who paid; older unnamed furnaces omit
it. Attribution does not change delivery rewards. `buyStoreItem` accepts the
socket owner's id and catalog `offerId`. The server checks living state,
Town Square proximity, settlement level, bank balance, and existing receipt.
Success returns `townStoreResult` with a notice, banked `score`, and `purchases`.
Repeated purchases spend nothing. Placeholder offers grant no gameplay effect.
Old owned hull colors remain readable, but paint and life purchases are retired.

Entities carry `cargo`, banked `score`, and `purchases`; there is no lives field.
World snapshots include `settlement` with level, points and four resource balances.
Asteroids may contain `ore` (null means barren); older rows derive it from a stable
ID hash. Point loot has kind `points` and a point quantity. Furnace refinement
credits resources once per rock and personal rewards once per distinct contributor.

The codec preserves all public JSON fields recursively. Future keyed arrays automatically participate in delta
encoding and other fields replace safely. Exhaustive shared DTO validator maps
make additions to the shared world/entity/asteroid/loot/EO/pickup/projectile/tag DTOs
require corresponding validation. `ServerGameSnapshot` extends the core
`ServerGameState` with `playerProjectiles` and `collabTags`. Projectile IDs equal their stable `shotId`,
so an event and subsequent keyframe repair one shot instead of creating two.
Tags include asteroid ID, shooter hit records and expiry. Keyframes restore active
shots and cooperative windows after reconnect without replaying old events.
All six EO pickup types, asteroid
shape/material/health, kits, E cooldowns, cable targets, survey contributors and
shared exploration tiles use the shared DTO contract. Public state must be finite JSON;
unsupported values fail loudly and close the negotiated socket instead of
silently dropping state. Unknown valid JSON fields remain intact.

Before encoding, the server rounds selected kinematics in its detached wire
world to four decimal places: asteroid position, velocity and rotation; loot
position; satellite pickup position, velocity and angle; spider position and
angle; and projectile
position, previous position where present, and velocity. Integers and values
above the safe multiplication cutoff remain exact. Every player field,
including motion-handoff anchors, remains exact, as do resources, timers,
counters, asteroid geometry/spin rate and unknown fields. This changes neither
server simulation nor collision authority. Encoder baselines retain the rounded
wire world so unchanged rounded values need no delta field.

## Baselines and recovery

Baselines and application credit are keyed by actual sockets in a WeakMap.
A new physical connection starts at sequence 1; same-socket rejoin preserves
the sent sequence frontier and outstanding credit, advances a local baseline
generation and demands a keyframe. During a same-socket rejoin, the client
continues decoding the old session until the ordered `joined` acknowledgment,
so snapshots already in flight do not trigger a false protocol error. An old
successful callback still accounts for its sent sequence and bytes, but cannot
install its baseline in the new generation. The first state is full. Subsequent
states use deltas until recovery requires a full frame or a full frame is smaller.

Baselines advance only in a successful WebSocket send callback. This acknowledges
the local transport write, **not remote application receipt**. After successful
world application the client sends `{type:"snapshotAck",data:{sequence}}`.
The cumulative acknowledgment retires only that currently owning socket's sent
frames. A receipt racing the send callback is retained without releasing credit
until the transport succeeds. Future, regressing and superseded-owner receipts
cannot change credit; a duplicate applied receipt is harmless.

Ordinary outstanding snapshots are bounded by 64 KiB, eight frames and a
750 ms offering-age limit. Offers blocked by pending writes, transport pressure
or applied credit leave the sent baseline alone and prepare no recipient world;
the next eligible offer samples current state and can remain a delta. A frame
larger than the ordinary byte window travels alone, within the existing 1 MiB
hard outbound bound. One reserved resync keyframe can follow rejected ordinary
deltas without clearing their debt, preventing a full-window recovery deadlock.
Its applied acknowledgment retires the older frames. Repeated resync requests
coalesce; a rejected sole oversized frame requires a new socket instead of
queuing a second oversized frame. Missing applied receipts close for recovery
after six seconds, or ten seconds with oversized outstanding work. Failed
transport writes also close and resume through a fresh socket; their receipt
and baseline are never treated as successful delivery. These bounds cannot make
an indivisible large keyframe arrive faster than the connection can transfer it.
Excluded recipients keep their own baseline. Each recipient receives nearby
asteroids, projectiles, loot and pickups within 2,800 world units on each axis.
The crew roster, shared exploration, and revealed `mapAssets` remain global.
These lightweight furnace and valuable-drop markers supply the universe map;
they do not require distant asteroid geometry. The outbound budget accommodates
a fully explored 120,000-unit-wide atlas on late joins and resynchronization.
Each detached view has
its own encoder; no baseline points at mutable game engine state.

The production `ConnectionManager` invokes `SnapshotDecoder` before normal state
application. Deltas require both the exact baseline and consecutive sequence.
Stale frames, missing baselines, invalid shapes, conflicting edits, duplicate
IDs and unsafe object keys are rejected atomically. The previous state remains
visible; the client coalesces `snapshotResync` requests until a valid frame arrives.
The server schedules a requested keyframe on its normal broadcast cadence, using
the single reserved recovery frame without discarding older application debt.
Initial joins and rejoins also require a keyframe. Otherwise the encoder retains
the latest successful baseline and sends a full frame only when the delta
envelope is not strictly smaller in UTF-8 bytes. There is no forced keyframe
interval. Ordered WebSocket delivery and consecutive decoder baselines support
sustained delta chains; pending-send skips consume no sequence. Missing valid
application ACKs still close the socket after the existing six-second timeout,
or ten seconds with oversized debt, so recovery can resume through a fresh
socket. A gameplay ingress budget refusal closes the connection rather than
silently dropping its resync request. Unnegotiated snapshots close with protocol
error.

## Verification

Run from `/Users/johnsolly/code/GeoRoids` (or the integrated checkout):

```sh
npx vitest run --dir tests/unit tests/unit/network/pilots-recover-complete-snapshots.test.ts tests/unit/network/current-pilots-share-a-server.test.ts tests/unit/network/runtime-client-negotiates-and-recovers.test.ts
npm run benchmark -- measure codec --revision HEAD --seed 42
npm run benchmark -- measure transport --revision HEAD --seed 42
```

The complete command and artifact contract is in the
[benchmark framework guide](../../benchmarks/README.md). A benchmark checkout
must be clean and committed. Each requested revision is archived and receives
the same benchmark code overlay, with dependency and before/after source hashes
recorded. Transport is a single-revision realtime sample; compare client, server
or codec with `npm run benchmark -- compare KIND --baseline REV --candidate REV`.

The retained code tests exercise protocol decoding, malformed-frame preservation,
entity updates, asteroid removals, unsupported-client rejection and pickup ownership.
Real-clock late-join and reconnect scenarios were retired because snapshot-credit
expiry could race their assertions. Run the retained server suite through its owned
integration runner:

```sh
./scripts/test-runner.sh tests/integration/server/
```

The current codec measurement uses the original seeded snapshot fixtures and
checks every decoded keyframe and delta against the fixture's expected wire state,
while preserving the original input as a mutation witness. It
exercises shared and staggered recipient baselines at 1, 2, 5, 10 and 25
recipients. Encode/serialize and decode timings are separate. Reported bytes are
UTF-8 application payload bytes from the JSON snapshot envelope, not WebSocket
transport framing. The transport measurement uses two real loopback clients and
an owned child server; its native scheduling is nondeterministic and its server
seed belongs to the server factory. The direct server runner uses two loopback
players.

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

## Reflective asteroid capability

The required `asteroidInteractions:1` join capability requires snapshot v2 and an
explicit matching acknowledgment. The joined socket alone receives its private resume token.
A physical gameplay socket close gives the live session a two-second neutral-input
grace. A same-socket rejoin is idempotent, and a valid token can atomically
supersede an old socket. After the live session expires, its persisted token hash
can restore the pilot and rotates on successful recovery. Leaving preserves
progress; resetting the test world invalidates it. The browser stores the private
token locally. Unsupported joins are rejected before a pilot is created.

Optional asteroid `phenomenon` metadata is preserved on first creation and
complete/delta updates. `playerProjectiles` carries stable process-unique shot
IDs, geometry, bounded fractional energy, bounce count, and age. The client
reconciles keyed projectile rows for bolt creation. Reflection energy uses finite
numbers in [0,8]; sequences, epochs, and bounce counters remain integers. Core
upgrades carry bounded charges and expiry.

Player poses use server motion epochs and monotonically increasing input
sequences. During reconnect handoff, ordinary movement packets cannot overwrite
position, velocity, or other authoritative movement state. The client rebases
each authoritative frame and replays only its bounded unacknowledged input queue.
A new handoff epoch and reachable-pose acknowledgment are required before free
prediction resumes. Server time and kit speed bound all subsequent free poses.

## Contour Lock

Movement poses carry `contourLock: {height, direction}` or `null` to release.
Capture requires a valid terrain gradient within 48 units of the selected level.
Height and direction stay fixed until release; the server requires convergence
within 6 units over 600 ms, velocity along the rail, and forward displacement
along the selected route. Speed and displacement
remain bounded by the kit cruise speed and server-time movement credit.
The shared guidance and limits live in `shared/contourLock.ts`.

Snapshot motion acknowledgments protect newer local capture/release input from
older echoes. A new authoritative epoch rebases the lock along with the pose.
Menus, death, pipe travel, any collision, knockback, and disconnect release the
lock. Protected asteroid contact also releases it without removing protected
health. Lasers pass through invulnerable hulls without breaking the lock; direct
crew shots also pass through without contact. Release
caps velocity back to ordinary contour cruise, except for server-owned knockback.
There is no charge, recharge timer, or cooldown; pilots may capture again immediately.

## Asteroid belt

`beltRecovery` lists imminent belt replacements with `slot`, `position`, `size`
and absolute `recoverAt` time. An empty list clears warnings. Clients draw a
non-colliding amber ring before the authoritative replacement appears.

Belt spiders share `spiderField.spiders` with terrain spiders. Their `crawler`
object contains `hostId`, the surface `anchor`, phase (`crawling`, `winding`,
`lunging`, `recovering` or `escaping`) and normalized `progress`. Position, health and
attack targets remain server-owned. Clients render rock-occluded crawlers as
faint silhouettes, rather than exposing a shootable target through cover.
`beltCrawlerHealth` on an asteroid carries persistent occupant health; parallel
`beltCrawlerIds` retain identity when a spider transfers to another host. Zero
health entries prevent revival on sector reload. During `escaping`, `hostId`
and `anchor` identify the destination, while `position` follows the visible leap.
This phase covers both pursuit hops between living rocks and escapes from a
destroyed host. The client folds the legs instead of drawing feet attached across
the gap.
