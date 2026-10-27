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
records the older-backup restore caveat. John lifted the stale-tab hold on wire
`deathCause` on 2026-10-26
([task `6hjWGhm4rvX2f5pv`](https://app.todoist.com/app/task/6hjWGhm4rvX2f5pv)).
Other unverified sweep rows remain planning data on
[task `6hjWGhqrx6rhMrrv`](https://app.todoist.com/app/task/6hjWGhqrx6rhMrrv),
not evidence of dead code.

## Per-client upgrade keying rejected; size the shared budget to the fleet, 2026-10-26

The deploy lockout — a full server could not rejoin, because the shared
connection budget sat below `MAX_PLAYERS` — is fixed by sizing that budget to a
full fleet's honest demand, not by telling callers apart. Keying upgrades to the
forwarded client address was attempted across four revisions and is rejected.
Do not reintroduce it without new evidence; what follows is what any attempt has
to solve.

**Re-keying destroys an aggregate bound `main` holds by accident.** Behind
Railway's edge the socket peer is the proxy, so every caller shares one bucket
and the whole internet is capped at one bucket's budget between them. That cap
is a side effect of the very bug being fixed, so attributing upgrades to real
clients removes it, and a replacement aggregate bound becomes mandatory.

**Every replacement bound tried hit one of two horns.** Sized below the sum of
the per-address budgets a full fleet legitimately holds, it refuses callers who
are inside their own budget, and spending it becomes the attack: one source
refused 488 of 600 honest joins. Sized above that, it is a shared resource one
host can exhaust. Bounding the per-address map instead moves the problem rather
than solving it — a 1,024-entry cap, filled by single upgrades from distinct
addresses, refused 100 of 100 honest pilots on fresh addresses and 98.5% of
honest joins over an hour from one host, and because the map was keyed per lane
a `/logs` flood closed the next `/ws` join.

**Narrower sub-bounds do not separate honest traffic from abuse either.** A
per-prefix budget (IPv4 /24, IPv6 /64) needs at least the fleet's worst honest
demand to spare a fleet that shares one prefix, while the aggregate ceiling is a
modest multiple of that same demand, so a number of prefixes well inside one
end-site delegation still fills it. A fair share of the lane reserved for
callers under an honest retry rate was built and measured: because the
past-ladder pool is shared, one caller empties it and every other past-ladder
caller is refused. One /24 took 606 upgrades before the pool refused it, after
which a pilot that had dropped twice lost 6 of its 12 upgrades and 20 pilots in
one /24 lost 14 of 20 — figures that are zero on an idle limiter and appear only
once the pool is full.

All of it fails for one reason: **a fleet sharing a prefix and one host rotating
inside that prefix are indistinguishable at an upgrade**, before any pilot
identity exists. That is a property of IP-keyed sub-bounds in general rather
than of any one implementation, which is why resizing a bound cannot rescue the
approach.

Address normalization — collapsing `192.0.2.4`, `::ffff:192.0.2.4` and
compressed IPv6 spellings of one host onto a single key — is the one rewrite
that costs honest callers nothing, because it only merges spellings of the same
host. It is unnecessary while the key is the socket peer, whose spelling the
caller does not choose, and it is the first thing to add if a forwarded address
ever becomes a budget key: `node:net`'s `isIP` is a format check, not a
normalizer.

One live path does key on a forwarded address today — the reporting listener's
status quota and its per-address report scope (`server/debugReports/http.ts`).
Normalizing there is backlog rather than work, with a precondition: first
measure whether the edge ever writes more than one spelling for one host. The
caller cannot influence that value, so the hole needs the edge itself to vary,
which nobody has observed.
