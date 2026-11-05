# Static halo cache prototype

The Canvas 2D flight painter shares one furnace ring/fire-bed bundle and one
Ricochet Court shadow bitmap. The intake pulse, flames, embers, court beams,
emitters and labels remain live. The portable furnace painter remains the
reference for Wiki demonstrations.

Furnace storage is capped at 1,000,000 backing pixels across two surfaces, with
each dimension at most 1024. Court storage is capped at 2,000,000 pixels and
1536 per dimension. Replacement releases old storage first; a fresh flight or
runtime teardown releases all retained storage. Oversized artwork uses vectors
at its native resolution. Scan and camera easing use vectors throughout, so
they never rebuild a bitmap at each zoom step.

## Local measurements

The October 23, 2026 prototype used main `26262f6d` as its reference. Native
Chrome comparisons covered DPR 1, 1.5 and 2, three fractional positions and three
flame/pulse times. The predeclared acceptance limits were no missing features or
clipped halo, at most one backing pixel of footprint movement, and total excess
luminance within 5%. The final shadow-only court prototype met those limits;
an earlier whole-court bitmap failed the luminance limit and was discarded.

| Isolated warm painter | DPR 1 | DPR 1.5 | DPR 2 |
| --- | --- | --- | --- |
| Furnace, vector to cached | 5.724 to 4.090 ms | 6.094 to 4.438 ms | 6.485 to 4.826 ms |
| Court, vector to cached | 2.105 to 0.859 ms | 2.916 to 1.176 ms | 3.531 to 1.445 ms |

These diagnostic timings force raster completion with readback and include its
overhead. They are local painter comparisons, not game frame times or Fire
Tablet FPS. The furnace subpass probe found flames the largest live component
(about 0.587 ms), ahead of embers (0.063 ms) and the static bed (0.042 ms), in
that separate readback workload. They must not be subtracted from whole-frame
timings. This prototype does not establish the physical tablet's remaining
GPU, presentation or thermal cost, and does not reinstate retired tablet tests.
