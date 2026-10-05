# Terrain grid browser diagnostic

This diagnostic compares the current production `createHeightGrid` and
`extractIsoContours` with the original terrain implementation at commit
`5cdaeedad8db22f5925dd4cdc176caa606bfc5be`. Every timed operation includes complete
contour extraction and a fresh production spatial index. It measures synchronous
CPU work, not gameplay FPS, presented frames, or physical-phone performance.

## Run

From a GeoRoids checkout, for example `/Users/johnsolly/code/GeoRoids`:

```sh
node benchmarks/terrain-grid/run.mjs
```

The driver resolves the repository from its own file location, independently of
the shell's current directory. An absolute path to the driver works from any
directory. Relative `--output` paths also resolve from that repository root.
The pinned baseline commit must exist in the local Git object database; the
driver never fetches, edits product code, or installs packages.

Defaults are CPU throttling 4, three pairs per comparison phase, ten warmups per
arm and twelve measured calls per arm. Optional arguments are `--output`,
`--cpu-throttle`, `--pairs`, `--warmups`, and `--calls`. At least five warmups and
ten calls are required. Run serially with other browser, test and benchmark work.
Use the checkout's supported Node version and existing installed dependencies.

Each invocation creates an owned `.performance/terrain-grid/run-*` directory.
Its default `report.json` and generated source remain as evidence, including on
failure. A supplied report path must be unused. The output records its evidence
directory even when the report is written elsewhere.

## Exact workload and baseline

The driver extracts four complete files directly from the pinned Git revision:
`heightfield.ts`, `passages.ts`, `contours.ts`, and `terrainConfig.ts`. It preserves
their bytes and original sibling imports under the run's `source/baseline/`.
No baseline module imports a current product arithmetic helper.

A generated `bootstrap.ts` loads the tracked entry as a side effect and supplies
typed baseline capabilities to its `window.installTerrainGridBenchmark` boundary. The tracked entry imports only existing
production modules, so regular TypeScript checks require no generated scratch
files. The HTML template and bootstrap are materialized under the same owned
source directory. `generation.json` records all generated input hashes; every
source identity check verifies them again. Generated sources are retained before
and after final identity verification.

The browser executes the actual current product functions, including uncommitted
changes. A dirty-tree receipt is development evidence, not pinned-release proof.
Source manifests traverse real TypeScript/JavaScript imports using the installed
Vite parser, including generated and type-only imports. They include the
tracked driver, entry, README and HTML, transitive modules, TypeScript configs,
package lock and installed toolchain package identities. Every actual Vite module
must belong to that pre-build manifest. Input identities must remain unchanged
through compilation, measurement and cleanup. Compiled asset hashes and byte
sizes are recorded. Do not modify any input during collection.

Twenty-one local patch cases cover three seeds: spawn, region crossing, two
generated landmarks, rim intersection, diagonal rim, and wider scan radius.
All use grid 96 and centers snapped to 1024. Normal patches use radius 2048,
matching the requested minimum radius 1536 after production padding and rounding.
The 4096-radius cases are labeled `scan-radius-kernel`; this diagnostic does not
establish a viewport-to-radius mapping. Eager small-world extraction is excluded.

## Correctness and timing

A separate observation context compares baseline and production heightfield
construction, complete Float64 height grids and min/max values, and every ordered
contour level and segment. Byte comparisons preserve signed zero. Four query
rectangles compare complete ordered results from the real spatial index. Receipts
retain SHA-256 digests, byte lengths, geometry counts, and coverage witnesses.
Rim cases must contain inside and outside samples; landmark cases must sample
their generated landmark. Exactness work stays outside all timing intervals.

The timing context shares no JavaScript state or caches with observation. Fields
are constructed outside the measured patch job, matching production ownership.
Both implementations warm before controls, then every arm warms again. Three
baseline/baseline pairs precede three alternating baseline/candidate pairs; three
more baseline/baseline pairs follow them. Two native animation callbacks separate
arms. Every measured call returns fresh geometry and builds its index; those
checks occur after its timer. Raw per-call durations and full arm wall time are
retained without replacing them with an aggregate performance verdict.

Chromium uses the native GPU setup and applies CDP CPU slowdown before navigation
in each context. Software rendering or missing accelerated GPU features fails
collection. Native clock resolution, idle animation timestamps, visibility,
browser/GPU identity and host CPU/load/memory are retained. Coarse browser heap
readings and derived buffer sizes are labeled; they do not measure total process,
transient allocation, or external-buffer memory.

## Isolation, failures and interpretation

The runner owns its compiler child, temporary compiled output, browser process,
contexts, and random-port loopback static server. It rejects external requests,
WebSockets, page errors and console warnings/errors. It attempts each cleanup
even after collection fails. Cleanup or source-identity failures fail the run;
partial receipts preserve the reported errors. Generated baseline and bootstrap
sources are intentional retained artifacts, not live resources.

Exit zero means complete collection with exactness, input stability and cleanup.
Assess normal-patch and scan-radius groups separately against their bracketing
A/A noise, retain individual pair results and regressions, and distinguish CPU
job savings from frame pacing. This diagnostic makes no automatic speed claim.
