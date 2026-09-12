# Decoder-owned snapshot input

The current client parses each server envelope inside the snapshot decoder and
avoids a second full DTO validation when retaining a baseline. The application
still receives mutable state, and the decoder keeps a separate deep copy.
Independent review accepted the isolated optimization and its product
integration. Combined browser/Wiki checks, all 1,232 unit tests and the production
build passed. The full shipping gate remains pending; this is not phone-FPS evidence.

## Ownership makes the change safe

Previously, ConnectionManager parsed the envelope and passed an arbitrary
object to the decoder. Validation ran while accepting a keyframe or applying a
delta, then ran again when the decoder captured its private baseline. Simply
removing that second validation would leave an object-input API whose caller
could supply getters or otherwise retain the input graph.

The sole receive API now accepts raw text, captures the caller's admission
state, and parses once. Snapshot objects reach an ECMAScript-private decoding
method without escaping. A successful decode validates the complete state,
then copies it with the existing finite-number, nesting, unsafe-key and plain
JSON checks. Only after that succeeds does it replace the private baseline.
Consumers can mutate the returned state without corrupting the next delta.
No freeze, structural sharing or public object-input compatibility path was
added. Server capture and encoding keep their existing validation contract.

Snapshots before the first join acknowledgment are rejected before baseline
mutation. Queued old-session snapshots remain admissible until a same-socket
rejoin acknowledgment resets the decoder. Malformed JSON still reaches the
transport parse-error handler; unknown typed messages reach ordinary dispatch.

## Controlled decoder measurement

The isolated comparison uses 300 captured combat worlds: one stream has four
keyframes and 296 deltas, and another makes every message a keyframe. Each arm
warms 300 messages and measures 600, with three unchanged A/A pairs and three
alternating A/B pairs per stream. The measured interval includes raw JSON parse,
validation, reconstruction and retained-baseline copying.

| Stream | Median paired time reduction | Paired range | Largest A/A variation |
| --- | ---: | ---: | ---: |
| Representative deltas | 15.38% | 12.14–18.92% | 0.39% |
| All keyframes | 13.95% | 13.90–14.17% | 3.54% |

Every candidate pair is faster than its matching control by more than the
largest A/A variation, and every candidate p95 is lower. These are Node 24.16
measurements on Apple M3, not a browser application, allocation/GC or rendering
result.

A second exclusive run directly imported the final product decoder, including
its optional diagnostic instrumentation. The same three A/A and three
alternating A/B pairs produced a **14.00% median delta-stream reduction**
(range 12.88–15.82%, maximum A/A variation 0.64%) and a **13.89% keyframe
reduction** (range 12.39–14.06%, maximum A/A variation 3.00%). Every paired
saving exceeded its mode's largest A/A variation. Source hashes remained fixed,
all state sinks matched, and independent review reproduced every total and
summary. The first table remains the original prototype evidence.

## Immutable-state follow-up

A bounded C3 prototype replaced retained copying with recursively frozen state
and reused unchanged subtrees between deltas. It retained the depth, unsafe-key,
finite-number and plain-JSON guards, including verified subtree heights for
safe reuse. All 2,659 wire cases matched C1; runtime mutation attempts failed,
atomic recovery passed, and server capture/encoding stayed unchanged.

The full raw parse/decode/retention comparison used the current C1 as control,
with the same three A/A and three alternating A/B pairs per stream. C3 was
**28.61% slower for representative deltas** (27.44–29.41% across pairs) and
**28.54% slower for keyframes** (25.61–35.85%). The largest unchanged-control
variation was 2.32% and 1.34%, respectively. Every C3 pair was slower.

The runtime guard erased the potential copy saving before any mutable client
consumer had been migrated. C1 remains the product implementation; no consumer
migration was attempted. Independent review reproduced all 14,400 raw samples,
pair calculations, state sinks and input hashes, and accepted the rejection.
This is a scoped result for the tested immutable design, not a universal claim
about all future representations.

## Correctness and caller integration

The isolated artifact checks 300 reconstructed worlds, 2,659 wire-boundary
cases across 166 field paths (627 accepted and 2,032 rejected), 11 atomic
recovery cases, source/result isolation, admission/rejoin ordering, optional
envelope fields and one parser call. JSON serialization collapses some
in-memory malformed variants; these counts should not be compared directly
with the earlier 3,002 object-input cases.

Product, benchmark and ordinary mixed-message test consumers use the decoder's
result to route messages. Codec validation reads state and sequence metadata
from that same result. Separate untimed raw-wire observers remain where tests
assert the exact envelope independently; they are instrumentation, not a second
parse in the shipped callback or timed decoder interval.

Focused product tests cover malformed raw JSON, unknown messages, first-join
admission, queued same-socket rejoin, mutation isolation and recovery. The final
focused set passed 58 tests across six files. TypeScript, benchmark TypeScript,
scoped formatting and unused-code checks passed during integration. The first
combined run had two unrelated Path2D fixture failures and a stale Wiki-review
failure. Both rendering fixtures passed after local test-only Path2D stubs.
The live combined run passed reconnect, sustained mobile controls and desktop/
mobile Wiki navigation. Its motion-socket test fixture initially discarded a
string error payload; preserving data as unknown until message-specific
narrowing fixed that observation, and all five real-socket scenarios passed.
A fresh Wiki source review, all 1,232 unit tests across 216 files and the
production build subsequently passed. The full shipping gate remains pending.

The [receipt](decoder-owned-input-receipt.json) records source and evidence
identities. Scratch artifacts remain in `.performance/decoder-owned-input/`
and `.performance/decoder-product/` in the implementation worktree.
