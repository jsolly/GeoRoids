# Measure atlas recovery bytes

This harness measures the real engine, legacy in-memory writer, message handler,
broadcaster, decoder, and application acknowledgments. It records exact UTF-8
snapshot and ACK payloads plus RFC6455 framing arithmetic. It does not measure
TCP, TLS, timing, browser rendering, or fleet capacity.

The retained corrected run used published `50a268a394f9232f76b9325c0398b547f19fd919`
before and published `a21c436d363be5051429ba9f6d3568f11af3bdbe` plus prepared
Atlas patch `6747e2d8161289077ea12fb5f909914a09faa7d05770dfae7c6ff54b1c85f134`
after. Exact canonical-world equality passed all three windows. Its comparison
artifact SHA-256 is `f06d42ad40f3423f8707be793bc5dbcac266c920faddad057bf08c5a7ed8e4c5`.

| Snapshot payload bytes | Before first frame | After first frame | Before total | After total |
| --- | ---: | ---: | ---: | ---: |
| Cold join | 215392 | 117143 | 215392 | 274602 |
| Unchanged same-socket resync | 215392 | 109377 | 215392 | 109377 |
| One-tile resync | 215392 | 109582 | 215392 | 109582 |

Cold join used 1 frame before and 21 after: its smaller first frame came with
higher total traffic. Candidate atlas bytes were zero for unchanged recovery and
204 for one-tile recovery. The current integrated source on published
`d87de3fef9f25947739a57e9d0e989d711896972` has not been measured; the retained
result does not certify that later source or its TCP, CPU or rendering behavior.

Credential-free raw snapshot text and independent payload hashes are retained
with the receipt, bounded to 8 MiB of payload and a 20 MiB JSON artifact. Join and
resume-control envelopes are never archived. Atlas member bytes count the legacy
keyframe exploration member or the new segment member, excluding surrounding
container punctuation. All container bytes remain in the total payload counts.

Use Node 26.13.1 and the same dependency lock in two disposable source extracts.
Use the retained published `50a268a394f9232f76b9325c0398b547f19fd919`
archive without Atlas as the before product. Pin the after product's actual
published base and exact Atlas patch separately; the retained run above used a21.
Record both bases and inspect their intervening changes; the comparator also
requires identical complete-world results. Keep production databases and the
retained loaded-battle evidence out of both extracts.

Copy the identical common harness into both extracts before retaining their
source archives:

- `benchmarks/atlas-resync.ts`
- `benchmarks/benchmark-identity.ts`
- `benchmarks/snapshot-oracle.ts`
- `benchmarks/websocket-frame-bytes.ts`
- `benchmarks/results.ts`
- `tests/support/recordingSocket.ts`
- `benchmarks/fixtures/atlas-resync-1200.json`

The old decoder is constructed through a typed, checked reflection boundary.
It ignores the extra live-mode constructor argument and reads its original
complete worlds. The candidate decoder enforces live worlds and reconstructs
the atlas. There is no production negotiation opt-out.

The harness owns the existing seeded benchmark UUID generator before engine
construction and releases it during cleanup. Satellite IDs retain their exact
generated values, length and order in both products; the comparator does not
normalize or omit them. A retained earlier run omitted this ownership and failed
exact-world equality on six satellite IDs, so that run is not a valid comparison.

Retain a source archive and JSON manifest for each extract. The manifest contains
`baseRevision`, a full 40-character commit; `patchSha256`, either null for the base
or the exact candidate patch hash; `artifactSha256`; and `files`, mapping repository
relative paths to their SHA-256 hashes. Include all authored files in `shared`,
`server`, `src`, `setup`, `benchmarks`, and `tests/support`, plus `shared-types.ts`,
`package.json`, and `package-lock.json`. The harness rejects missing source entries,
symlinks, changed source or archive bytes, and inventories above 4096 files or
128 MiB. Hashes identify an uncommitted candidate without calling it a published
commit. Keep the common harness bytes identical across both products.

Run these commands once root grants the measurement slot. Use the prescribed
environment and process supervisor around each command. Paths below refer to
owned private measurement artifacts and each command runs from its product root.

```sh
/home/agent/.local/share/mise/installs/node/26.13.1/bin/node --import tsx benchmarks/atlas-resync.ts --fixture benchmarks/fixtures/atlas-resync-1200.json --source-manifest /PRIVATE/before-manifest.json --artifact /PRIVATE/before.tar --output /PRIVATE/before-receipt.json
/home/agent/.local/share/mise/installs/node/26.13.1/bin/node --import tsx benchmarks/atlas-resync.ts --fixture benchmarks/fixtures/atlas-resync-1200.json --source-manifest /PRIVATE/after-manifest.json --artifact /PRIVATE/after.tar --output /PRIVATE/after-receipt.json
/home/agent/.local/share/mise/installs/node/26.13.1/bin/node --import tsx benchmarks/compare-atlas-resync.ts /PRIVATE/before-receipt.json /PRIVATE/after-receipt.json /PRIVATE/comparison.json
```

The fixture restores 1200 exact tiles and then uses the same real pilot join in
both products. Any ordinary spawn discoveries remain part of the independently
checked complete world. The clock and date are fixed. The windows are:

1. First join through complete atlas reconstruction.
2. An unchanged same-socket world resync after all application credit is repaid.
3. One real known-empty survey bit, a legacy checkpoint, and same-socket resync.

Every decoded moving world matches the independent existing public-state oracle.
Each completed atlas must equal the full canonical world. Receipts separate the
first keyframe, all cold-baseline traffic, atlas fields, ACK uploads, and framed
bytes. Comparison requires identical fixture, common harness, runtime, and
complete reconstructed-world digests. It also requires zero atlas bytes in the
candidate's unchanged recovery. A smaller first frame alone is not evidence of
lower total cold-join traffic.

The existing wire-ledger remains the separate real-loopback TCP accounting check.
Run it against the final integrated source under the same reserved slot before
claiming observed wire-byte results. Keep privacy and local-interest assertions
intact. Source tests and framed-byte arithmetic do not certify rendering or a
phone's recovery latency.
