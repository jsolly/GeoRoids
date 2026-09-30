# Native integration repeatability

The manually dispatched **Integration repeatability** workflow runs the same full
`main` commit SHA on native Ubuntu 24.04 x64 and ARM64. Each architecture runs 20
serialized repetitions of the complete audio lifecycle file, then three complete
integration suites. Every focused repetition includes Chromium and WebKit at desktop,
mobile, and landscape sizes, so each combination has 20 attempts. A failed attempt
remains a failure even when later attempts pass. The two matrix jobs do not cancel
each other.

The approved sample is evidence of repeatability, not proof of zero flakiness.
Setup failure, cancellation, timeout, missing attempts, missing reports, skipped or
todo tests, and failed artifact retention cannot establish a passing sample.
The workflow has a 180-minute outer deadline. Individual runner deadlines, browser
scenario budgets, native audio policy, and serialized worker configuration remain
unchanged. A job that reaches its outer deadline has an incomplete sample.

## Run and retain a sample

Dispatch the workflow with one full lowercase `main` SHA. It rejects revisions
outside `origin/main`, preventing a fork or unmerged branch from supplying the
executable test code. The workflow uses read-only repository permissions and does
not pass secrets to test code. Locked npm dependencies and their pinned Playwright
browser binaries are installed on each native runner. Before `npm ci`, the
workflow installs Ubuntu's build tools, pkg-config, Cairo/Pango, JPEG, GIF and SVG
development headers. The locked canvas 3.2.3 README lists Linux x64 prebuilt
binaries; native Linux ARM64 needs these source-build prerequisites. Apt setup
output is retained alongside npm/browser setup output, including failed setup.

For an additional local sample, run this from the clean pinned checkout at
`/Users/johnsolly/code/GeoRoids`, after installing its locked dependencies and native
Playwright browsers. This Mac ARM sample supplements the Ubuntu matrix.

```shell
cd /Users/johnsolly/code/GeoRoids
node scripts/integration-repeatability.mjs \
  --sha "$(git rev-parse HEAD)" --focused 20 --full 3 \
  --output "$PWD/.performance/native-repeatability-$(date +%Y%m%dT%H%M%S)"
```

Use a fresh output directory. The script rejects a different checkout SHA or
checkout changes. Smaller explicit counts are available for an approved diagnostic
sample, including `--full 0`; they must be reported as a smaller sample rather than
the full acceptance sample. There are no retry options.

The report records the exact SHA, lockfile hash, Node/browser versions, native
architecture, OS/kernel/runner image, CPU/memory/load, repository seed defaults,
and unchanged execution order. Fixtures retain their own seeds and unseeded
randomness remains visible in the source at the pinned SHA. The script does not
invent a global seed or override the runner's protected sequence settings.
Each attempt retains start/end timing, runner exit or signal, stdout, stderr,
combined output, Vitest JSON, game logs, and newly created or changed screenshots
and lifecycle receipts. The artifact index identifies unchanged files from older
attempts rather than attributing them to the current attempt. Evidence is copied
before another runner can clear its logs. An incomplete `report.json` survives an
interrupted sample. An output-file or console-sink failure signals only its owned
runner with TERM, waits for the runner's cleanup and closure, and retains the
failure even if the runner exits zero. A failed runner-receipt write is retained
alongside the original output failure. Small Node contracts exercise real file
write errors and console-stream failures while an owned child is running, then
verify that child has stopped.

## Read native audio evidence

The lifecycle probe leaves native creation, playback, decoding and browser
user-gesture authorization intact. Its bounded 512-entry trace records monotonic
sequence/time, native context creation/state changes, resume/suspend/close calls
and native promise settlements, trusted and synthetic gestures, user activation,
visibility, and buffer-source start/stop/ended events. Snapshots report any dropped
trace entries. Native superclass time, the original base-class getter and the injected observed
clock are recorded separately.
The clock fault changes only the observed getter on the original context.

The title/flight scenario proves that a native snapshot reads current native state
independently of a deliberately obsolete event-published cache. It still requires
an advancing initial native clock before the injected stall, all old contexts
closed, the replacement running with an advancing native clock,
and only the current loop active. Player identity, socket count/connectivity,
preferences, and unintended-shot checks remain intact. Native creation and resume
remain synchronous within the trusted recovery event; the test does not await old
context closure before requesting the new context.

Lifecycle receipts are written before browser cleanup on successful and failed
scenarios. They identify the last reached stage, native snapshots, cached
observations and capture errors. A failure to capture or write evidence fails the scenario while retaining the
original scenario failure. Focused unit contracts exercise a real unavailable
receipt directory and failed serialization. Repeatability script contracts run
automatically through `check:actions` in the gate and CI.

## Investigation status

[#714](https://github.com/jsolly/GeoRoids/issues/714) historically observed
`["running","suspended"]` instead of `["closed","running"]` in WebKit desktop/mobile
on x64. Those failures did not establish whether native transitions, browser policy,
or the event-published probe observation caused the mismatch. The old probe cached
state only on `statechange`, so instrumentation now distinguishes cached observations
from native state. This is an investigation lead, not a demonstrated historical
cause or a product lifecycle repair. One supplemental native Mac ARM diagnostic
attempt passed all six Chromium/WebKit viewport cases with no skipped tests. Its
WebKit traces showed trusted activation, synchronous replacement creation/resume
requests before old-context close fulfilled, then old closed/new running and an
advancing native clock. This uncommitted diagnostic attempt did not reproduce the
historical failure and does not satisfy the approved clean pinned ARM/x64 sample.
After integrating PR 2 at `e0ef52be13a62e02b27590995cc4c2d612a57c67`, a supplemental
native Mac ARM diagnostic failed five audio cases. Four failures observed a running
native clock that did not advance, including an initial WebKit clock already at
zero before the injected stall. Chromium mobile completed its scenario but failed
post-test evidence capture during navigation. Preserve that attempt in
`.performance/pr3-merged-focused-failed`; it does not establish the historical cause.
Independent trusted native controls subsequently showed advancing raw clocks with
and without the probe, including repeated page-owned buffer-context disposal.

The latest frozen dirty-tree audio diagnostic passed six tests in one file in
35.92 seconds with runner exit zero, retained in
`.performance/native-focused-initial-raw`. Initial and replacement clocks advanced,
raw and superclass readings agreed, no lifecycle records were dropped, and all
native playback, gesture, identity/session/input and preference assertions passed.
An explicit final Wiki URL/load/document barrier also passed. This later success
neither explains the earlier failure nor establishes cross-architecture
repeatability. No product lifecycle fix or browser-policy bypass was introduced.
The historical cause and full clean pinned repeatability evidence remain unresolved.

[#717](https://github.com/jsolly/GeoRoids/issues/717) also requires the separate furnace
and crawler investigations. Keep it open until all linked investigations have their
own demonstrated causes and regression evidence. Existing sample-rate and contour
fixture regressions remain required. Instrumentation and test orchestration change
no gameplay instructions, controls, or settings, so no in-game Wiki topic changes.
