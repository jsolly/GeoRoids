# Diagnosing a game session

The client and authoritative server use the same versioned JSON log envelope.
Server records go to `logs/server.log`; forwarded browser records go to
`logs/client.log`. Both also reach Railway's standard output. Browser warnings,
errors and selected `STATE` events are forwarded through `/logs`; ordinary
debug output stays local. Logging must not construct entity dumps every frame.

## Find the same incident on both sides

Every record has a timestamp, source, level, release ID and message. When known,
it also carries a player ID, page session ID and connection ID. A page session
is unique to that loaded tab and survives socket reconnects. Connection IDs
distinguish physical socket attempts within that page. A resumed player can
therefore retain a player ID while acquiring a new connection or page session.

Client timestamps come from the player's clock. The server adds `receivedAt`
and `receiverReleaseId` to forwarded records. Compare those fields when clocks
disagree or an offline queue arrives late. Client records remain untrusted
observations: a claimed player ID does not authenticate the sender. The server
record is the authority for accepted movement, damage, death and respawn.

Run these commands in `/Users/johnsolly/code/GeoRoids`:

```sh
npm run --silent logs -- --player PLAYER_ID --last 100
npm run --silent logs -- --session PAGE_SESSION_ID --source client
npm run --silent logs -- --since 2026-09-08T12:00:00Z --last 500
npm run --silent logs -- --file /tmp/saved-server.jsonl --file /tmp/saved-client.jsonl
```

The reader merges current and rotated files, filters before retaining the
newest records, and emits JSONL in chronological order. Forwarded rows use
server receive time; other rows use their event timestamp. That ordering helps
investigation but does not prove causality across a delayed network. Summary
counts go to stderr. Missing explicit files fail the command; absent optional
rotation files are normal. Legacy text and malformed records are counted as
ignored rather than presented as successful structured evidence.

## Follow a state transition

Start with connection, join, resume, resynchronization, motion rejection,
damage, death or respawn events. Match player and release IDs, then inspect the
surrounding snapshot checkpoints. Snapshot sequence numbers belong to a
connection; `gameTime` is the authoritative simulation tick counter.

Snapshots are sampled at sequence 1 and then every 450 sequences. At the normal
30 Hz broadcast rate, ongoing samples are about 15 seconds apart. Sampling
happens before copying state. The server checkpoint captures the state passed
to a successful socket send callback; that callback does not prove the browser
received or applied the packet.

The corresponding client checkpoint records the accepted packet metadata and
three observations: `clientBeforeApply`, `authoritativeRow`, and
`clientAfterApply`. Compare health, lives, position, velocity, motion epoch and
acknowledged input where available. Position differences can be normal during
prediction and reconciliation; do not diagnose desynchronization from a single
unequal coordinate. Rejected snapshots record the baseline/sequence problem
while preserving the last accepted state and requesting resynchronization.

Repeated motion rejections and damage reports are sampled; death and respawn
transitions remain explicit. Browser runtime errors and rejected promises enter
the same pipeline. A failed game frame stops the affected loop and presents a
restart notice, retaining the original error for diagnosis.

## Search production logs

Railway captures standard output and supports filtering structured JSON fields.
Start with these queries, substituting the incident's player or release ID:

```text
@category:STATE AND @playerId:PLAYER_ID
@source:client AND @sessionId:PAGE_SESSION_ID
@level:error OR @level:warn
@releaseId:COMMIT_SHA
```

Server warnings use standard output with `level: "warn"`: Railway treats stderr
as error severity. Keep records on one line and below the application's size
limit. Railway also imposes an ingestion rate limit, so per-frame log spam can
erase useful evidence. See [Railway logging](https://docs.railway.com/observability/logs)
for the query syntax, platform limits and plan-specific retention.

Vercel hosts the static client. Its build and runtime logs help diagnose builds,
delivery and middleware; browser JavaScript state reaches the game server
through the forwarding pipeline above. Check the client's `x-release-id` header
and the server's `/health` release ID before comparing deployments. See
[Vercel logs](https://vercel.com/docs/logs) for the distinction between build and
runtime evidence.

## Boundaries and loss

Logging is best effort, with bounded messages, queues, transport buffering and
rotated files. Counters in `/health` and `/status` report connected log clients,
queue pressure, dropped records and write failures. A zero counter only covers
what that process observed; it cannot prove that every browser event arrived.
An offline page or terminated process can lose diagnostics. A failed disk flush
must report failure even when the same records reached Railway standard output.

Each file retains its current 10 MiB segment and one rotation. Browser and file
queues are capped at 256 KiB; the browser also checks socket backpressure.
Client ingress limits each socket to 120 messages and 256 KiB per minute. Inspect
`logging.clientIngress` for accepted, invalid, rate-limited, dropped, queued and
failed-write counts, and `logging.serverWriter` for server-file outcomes.
The writer reports `stdoutDroppedRecords` and `stdoutWriteErrors` separately;
standard-output and file failures must not mask one another.
An stdout failure or buffer-limit drop writes a bounded `stdout_write_failed` error, including its
safe cause and error code, directly to the file queue. That fallback never
re-enters stdout; if both sinks fail, the health counters still show degradation.
`clientReportedDroppedRecords` records browser-reported queue loss after a
connection recovers; it is a reported count, not independently verified delivery.
The status page labels lifetime losses separately from current queue size.

Contexts are copied when logged, with bounded depth and text length. Sensitive
fields are redacted, and page URLs omit query strings and fragments. Do not log
chat, player names, authentication/resume tokens, complete packets or full
world state. Legacy plaintext clients remain wire-compatible, but their prose
is replaced with a redacted marker and byte count. Production exposes aggregate
logging health, not a public endpoint
for reading log contents. Test-only diagnostic routes stay disabled there.

## Profile the correct loop

The live client frame path is `eventLoop` → `GameController.updateGame` /
`renderGame` → `canvasManager.drawGame`. Measure that path when investigating
frame cost. Separate simulation, render and transport measurements, warm up the
fixture, and state its entity/projectile load. Synchronous render batches measure
canvas command submission, including any flush work paid inside those calls;
they do not measure display FPS, GPU completion or animation-frame scheduling.

The supported entry point is `npm run benchmark -- measure <kind> --revision REV`.
The [benchmark framework guide](../benchmarks/README.md) defines the four runners,
comparison protocol and retained artifacts. The harness must be clean and
committed. The runner archives each product revision, overlays the same benchmark
code, verifies dependencies, and checks source and dependency hashes before and
after the run.

Run these examples from `/Users/johnsolly/code/GeoRoids`:

```sh
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport desktop
npm run benchmark -- measure client --revision HEAD --seed 42 --viewport touch-portrait
npm run benchmark -- measure server --revision HEAD --seed 42
npm run benchmark -- measure codec --revision HEAD --seed 42
npm run benchmark -- measure transport --revision HEAD --seed 42
```

Each invocation prints a unique `/tmp/georoids-benchmarks/run-*` directory. Keep
its raw JSON, command logs, setup records and failure artifacts when investigating
a result. A completed report means owned browser, socket, server and child process
cleanup also completed.

The client runner compiles the diagnostic fixture and runs Chromium at desktop
1920x1080, touch portrait 390x844, or touch landscape 844x390. The timing context
and observation context are fresh and separate. Timing uses real
`requestAnimationFrame` timestamps plus native `performance.now()`. `updateMs` and
`renderMs` measure synchronous update and Canvas2D submission CPU work. They do not
measure presented frames or GPU completion. The observation context wraps native
`CanvasRenderingContext2D` and `Path2D` methods and counts actual API calls,
including HUD and environment probes. Those counts describe API submissions, not
GPU draws, and remain outside the timed context.

The server runner directly advances `GameEngine` with two real loopback human
connections and two bots created by the seeded engine. It fixes `Date.now()` and
seeds `Math.random()` while using native `performance.now()` for tick samples.
Natural authoritative simulation remains active, so asteroid, loot, satellite and
pickup counts before and after the measured ticks are recorded. This direct runner
does not establish production server capacity.

The codec runner uses the original seeded snapshot fixtures. It decodes every
keyframe and delta and checks equality with the original fixture, including
staggered recipient baselines. Encode/serialize and decode timings are separate.
Byte counts are UTF-8 application payload bytes from the JSON snapshot envelope;
they exclude WebSocket transport framing.

The transport runner starts an owned child server and connects two loopback
clients. It measures realtime ping RTT, snapshot delivery intervals, packet and
UTF-8 payload counts, client buffering and child-server event-loop delay. Native
scheduling is nondeterministic. The sample seed selects client IDs and requested
poses; the server seed belongs to the server factory. Transport accepts one
revision and is not a paired comparison.

For client, server and codec comparisons, the runner performs three baseline A/A
calibration pairs and twelve A/B pairs, alternating pair order. Workload
parameters and canonical outcome witnesses must match. Work counts must repeat
within each revision; differences between revisions are reported separately. A
changed outcome or nonrepeatable count rejects a comparison even if timing is lower. The
report's interval is a fixed-seed descriptive interval for these samples and
machine conditions. Read timing and `work` counts separately; the framework does
not label a generic performance win. `inconclusive` and calibration drift are
valid outcomes. Use a browser performance trace or device observation when a
presented-frame or compositor question remains.

Vite's profiling tools diagnose development startup, transforms and build work.
They complement runtime game profiling. See the
[Vite performance guide](https://vite.dev/guide/performance) for `--profile` and
transform diagnostics. Keep performance changes tied to measured work and
preserve feature behavior with focused scenarios.

For Canvas2D candidates, use the
[MDN canvas performance guide](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas).
The game already uses an opaque context, animation-frame scheduling and batched
contour strokes. Measure repeated primitives, state changes and text work before
adding caches or layers. Preserve smooth vector motion and the existing visual
style; image-coordinate rounding advice does not justify quantizing ship or
asteroid simulation coordinates.
