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

Health regeneration already runs on the authoritative server. Ship tuning is
1 HP per second after five seconds without damage. Another hit restarts the
delay, healing caps at maximum health, and a client update cannot clear the
server timer. The wire scenario checks that both pilots receive the same delayed
recovery after an asteroid impact.

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
