# Current binary codec feasibility result

The current MessagePack snapshot candidate is rejected. It cut raw bytes by
14.735% on the moving periodic-keyframe delta stream and 14.460% with churn,
but made the complete one-recipient encode/read/apply operation 11.559–15.346%
slower across all six primary paired comparisons.

The decision rule was fixed before execution: every MessagePack-versus-JSON
paired slowdown had to be at most `max(10%, the same stream's largest absolute
JSON/JSON relative drift)`. Moving JSON/JSON drift peaked at 2.184% and churn
drift at 0.815%, so each stream had a 10% cap. All three MessagePack comparisons
in each stream exceeded it.

| Primary stream | JSON bytes, all 210 correctness frames | MessagePack bytes, all 210 correctness frames | Byte reduction | Maximum JSON/JSON drift | MessagePack slowdowns | Cap |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| Moving, periodic keyframes | 1,752,746 | 1,494,482 | 14.735% | 2.184% | 12.885%, 11.559%, 13.203% | 10% |
| Moving with churn, periodic keyframes | 1,776,468 | 1,519,587 | 14.460% | 0.815% | 12.215%, 11.848%, 15.346% | 10% |

The screen used the current `SnapshotEncoder.encodeSerialized` and
`SnapshotDecoder.readMessage` as the JSON control. The candidate used current
`SnapshotEncoder.encode`, pinned `@msgpack/msgpack` 3.1.3, exact integer and
UTF-16 adapters, and a parser-owning reader with the same C1 validation, patch,
and retained-baseline behavior. Ordinary events remained text. The scope was one
recipient and makes no fanout claim.

Before timing, 210 frames per stream passed the independent current P4 oracle,
protocol metadata, unchanged-input, exact-codec edge, admission, malformed,
duplicate, and truncated-input checks. Timing used 30 warmup and 180 measured
snapshots per operation and three JSON/JSON pairs plus three alternating
JSON/MessagePack pairs. The loop was unpaced; 60 Hz simulation and 30 Hz
snapshots describe deterministic source advancement and snapshot cadence, not
wall-clock simulation, sockets, or delivery.

The table's byte totals cover all 210 correctness frames: the 30 warmup frames
plus the 180 measured CPU frames. They are this CPU harness's raw-byte diagnostic
and are not pooled with the earlier 180-frame raw-only probe, which independently
reported 14.202% moving and 14.075% moving-with-churn reductions.

The pre-execution static critic reported `BAR MET` on runner SHA-256
`0e074f2a3e7d031fc569f3b533c039bcceb971fbf785e914dc8195e65982fb03`.
The independent post-run critic reported `DECISION VERIFIED` after checking the
raw receipt, cap arithmetic, status, decision, correctness and source witnesses,
and the planned stop condition.

The browser replay, 5 Mbps live raw-wire screen, and phone FPS measurement were
not run because the primary Node CPU screen triggered the predeclared rejection.
No product source or dependency changed.

The tracked compact evidence is `current-binary-codec-receipt.json`. It binds the
complete 502,999-byte local raw receipt by SHA-256
`80ee2cfe970ae2cca2031801e809b07f5e5fd8ba38ff5c8abee6ce08d4ac9c39`.
