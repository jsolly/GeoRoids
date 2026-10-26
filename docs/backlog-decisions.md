# Backlog reconciliation

Reviewed against `origin/main` at `b6526529` on 2026-09-30. This records the
decisions for the backlog's first PR; it does not close the remaining gameplay work.

Current frontend guidance supersedes the former stack exception: Astro manages
Vite and static documents; Svelte 5 and shadcn-svelte own DOM interfaces. Canvas2D
and shared TypeScript gameplay remain. Browser suites and their harness repair
requirements are retired; the commands and receipts below are historical evidence,
not instructions to restore them. See [agent operations](agent-operations.md).

## Keep the current module and rendering conventions

Keep relative imports and imports from defining modules, as required by
[AGENTS.md](../AGENTS.md). Client, server, shared rules, tests and build scripts
already use this convention. TypeScript has no path aliases to maintain across
those execution paths. No alias or barrel benchmark establishes a runtime or
maintenance benefit here. The [unused-code measurements](quality-benchmark.md)
show the value of checking exports directly, rather than adding re-export layers.

Keep Canvas2D. The [mobile implementation evidence](performance/mobile-implementation-status.md)
records measured improvements to the current renderer, collision work and
snapshot processing. A WebGL or renderer-library migration needs a sustained
device trace showing a remaining dominant rendering cost before its complexity
is justified. The historical desktop measurements do not prove phone frame rate,
thermal behavior or a performance ceiling. Physical-phone acceptance remains
unrun, as recorded in the [phone measurement plan](performance/phone-fps-measurement.md).

## Existing gameplay and operations

Health regeneration runs on the authoritative server using `SHIP.HEALTH_REGEN_*`: 2% of maximum health per second after five seconds without damage. Another hit restarts the delay, healing caps at maximum health, and client updates cannot clear the server timer. `tests/unit/server/health-regeneration.test.ts` guards these rules; the wire scenario below refers to its reviewed revision.

Surveying already reveals the shared exploration chart and records survey owner
IDs on nearby eligible rocks. A moving survey probe pulses from its host; a
nearby Hauler receives the probe and the Scout's survey attribution. This proves
shared nearby survey state, not a promise that every remote rock is broadcast.
Snapshots retain the documented world-interest limits.

Railway hosting and correlated client/server logs are already shipped repository
capabilities. [Deployment instructions](agent-operations.md#railway-game-server) require
successful Railway deployment verification independently of Vercel.
[Diagnostics](diagnostics.md) describes JSONL logs, browser forwarding, Railway
output and the player/session timeline reader. This reconciliation did not run a
fresh production deployment or inspect production logs.

## Fresh focused verification

Executed in this checkout on 2026-09-30:

- `npx --no-install vitest run tests/unit/server/health-regeneration.test.ts`:
  four tests passed, including delay, cap, repeated damage and client authority.
- `./scripts/test-runner.sh tests/integration/server/pilots-see-health-recover-after-an-asteroid-impact.test.ts tests/integration/browser/sanity/scout-launches-a-shared-moving-probe.test.ts --reporter=verbose`:
  three tests passed. The browser scenario used Scout and Hauler pages at desktop
  and touch viewports and checked the observer's shared probe/survey state.

The first unit attempt could not find installed Vitest. `npm ci` completed, then
the commands above passed. Touch emulation is not physical-phone evidence. The
full gate and release verification belong to the shipping step.

No player behavior or Wiki semantics changed, so no Wiki article update is
needed. The test-writing instructions are now consolidated in
`tests/AGENTS.md`, including the prohibition on browser tests.

## Maintenance separated from human testing, 2026-10-14

The maintenance from PRs #815–817 is reapplied to the current game on `main`.
Their original branches include held gameplay and co-op work, so those branches
are not the merge input. PRs #809–812 and #814 retain interface, gameplay,
client-policy and campaign changes for human testing. PR #801 retains the new
Railway preview capability and its live setup acceptance.

| Maintenance item | Result and retained contract |
| --- | --- |
| Fixture phenomena | Seed unmanaged fields once through `ensureAsteroidField`; keep regional seeding and make its helper private. |
| Complete snapshots | Require the four always-emitted world fields in types and decoder; reject missing fields and delta clears, preserving immutable cached spider data. |
| Spider boundaries | Require the four existing callbacks; isolated tests supply explicit resolvers without adding production resource scans. |
| Build identity | Derive the short label, diagnostic logs and performance receipts from the validated full identity; retain complete provenance and archive tokens. |
| Feedback cues | Centralize ten tuples in `AUDIO` with identical paths, counts and volumes. |
| Health | Own the production builder in `server/health.ts`; derive status once and count players only in `world.players`, retaining 503 on persistence failure. |
| Unused Svelte files | Prove the existing Knip graph rejects an orphan and a comment-only reference while accepting a live Astro import. |
| Dead helpers | Remove `isReleaseId` and `RegionalAsteroidField.hasVisited`; preserve the parser and the visited-sector set used by persistence tests. |

W3 moves transport stories to the server integration runner, consolidates input
proof in unit tests, and removes duplicate or vacuous assertions. The two
cleanup cases that deliberately fail multiple client closes and a server close
remain under `tests/unit/testing/`; their live helper must settle and report all
failures. Current `PlayerInput`, `NetworkManager`, asteroid constructors, death causes and gameplay
behavior remain. W4 simplifies smoke errors and cleanup, removes the unused
shot-acknowledgement admission flag while keeping accepted-shot receipts,
consolidates validation instructions, and strengthens actual Wiki simulation
proof without importing future demonstration artwork.

Keep `chooseCrewSpawn` in `shared/player.ts` and snapshot `isPaused`; both have
live consumers. Keep the owner-less burn normalizer until the production scan
and retained-backup dates satisfy its existing task; [world operations](persistent-world.md)
records the older-backup restore caveat. Keep wire `deathCause` and
`findShipAsteroidOverlaps` until W2 and W3 meet their merged-and-live prerequisite
in [task `6hjWGhm4rvX2f5pv`](https://app.todoist.com/app/task/6hjWGhm4rvX2f5pv).
Other unverified sweep rows remain planning data on
[task `6hjWGhqrx6rhMrrv`](https://app.todoist.com/app/task/6hjWGhqrx6rhMrrv),
not evidence of dead code.

## Upgrade bucket keys are normalized, not aggregated, 2026-10-26

The WebSocket upgrade limiter charges each caller's own budget to one key per
host and aggregates no prefix; the lane ceiling remains the only wider control.
`normalizeClientAddress` in `server/communication/clientAddress.ts` collapses
every spelling of one address — IPv4-mapped forms, `%zone` suffixes, compressed
IPv6 — because `node:net`'s `isIP` is a format check and each spelling otherwise
keyed its own budget. Two wider mechanisms were built on PR #877 over PR #873's
limiter, measured against that limiter, and removed. Do not reintroduce either
without new evidence.

**A per-prefix budget (IPv4 /24, IPv6 /64) — rejected on arithmetic, never
built.** Sparing an honest fleet that shares one prefix requires a budget of at
least `MAX_PLAYERS * WORST_HONEST_UPGRADES_PER_PILOT`, which is half the lane
ceiling, so two prefixes still fill the lane; sized any smaller it refuses
ordinary shared-prefix traffic. No revision implemented it, so it has no
measurements of its own — the arithmetic is the whole argument.

**A fair share of the lane for callers under an honest retry rate — built,
measured, removed.** Half the ceiling was held for networks spending at or under
one pilot's reconnect ladder, with everything past that ladder drawing on a
single lane-wide pool. Because the pool is shared, one caller empties it and
every other past-ladder caller is then refused. Measured against that revision:
one /24 took 606 upgrades before the pool refused it, leaving the lane half idle
at 606/1200; with the pool full, a pilot that had dropped twice lost 6 of its 12
upgrades and 20 pilots in one /24 lost 14 of 20. Those two figures are zero on
an idle limiter and appear only once the pool is full — the pool is charged only
after a prefix passes the ladder, so a flood of many prefixes making few
upgrades each never fills it. A flood spread across 100 prefixes refused the
entire honest fleet. The tier was also bypassed outright by rotating prefixes at
the honest rate: 200 prefixes times 6 upgrades filled the lane with the share
never charged. Keying that share per network rather than lane-wide was tried
only as a reviewer's mutation of this revision, not as a commit, and took honest
refusals from 12 to 600 under a two-prefix flood; that figure describes code this
branch never carried, so it cannot be re-derived from history.

Both fail for one reason: a fleet sharing a prefix and one host rotating inside
that prefix are identical at an upgrade, before any pilot identity exists. So the
per-address budget and the lane ceiling — sized at twice the fleet's worst honest
demand — are the controls, and a caller holding several prefixes is bounded by
the lane alone. That is deliberate, as are two narrower residuals: normalizing a
link-local `%zone` away charges two interfaces of one multi-homed peer to a
single key, which no deployment behind Railway's ingress can reach; and
unattributable upgrades share one `UNATTRIBUTED_CLIENT` budget bounded by the
lane. The reporting listener's own quotas key on the same normalized address and
are likewise per-host, not per-prefix.
