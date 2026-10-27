# AGENTS.md

## Ship

Ship profile: `vercel-static`.

**Integration: branch → reviewed PR → merge on green `CI / ci`.** Follow [local release instructions](docs/development.md). Agents never push to `main`, change rulesets, or admin-merge.

Local gate: `npm run gate`; static checks, hook trust/bootstrap fixtures, runner contracts, the complete unit suite, build, and all server integration tests are mandatory. CI runs independent static, runner-contract, complete code-integration and Wiki media lanes; all must pass. Browser tests and automatic frame-work/constrained-client gates are retired.

Deploy: Vercel Git at <https://www.georoids.com> plus Railway Git at <https://georoids-production-2403.up.railway.app>. Classify server inputs with `scripts/server-release-inputs.mjs` from the merged checkout; its server/shared/setup/manifest inputs determine which Railway release needs verification, and it fails if server code imports `src/`. A successful client deployment cannot prove the server deployed. Successful production Git deployments establish the release. Do not gate builds or production smoke on served release metadata, bundle SHA searches or server SHA ancestry. Follow the canonical smoke receipt through asset availability, genuine join, snapshots, movement, accepted firing and healthy persistence. Production smoke uses HTTP/assets and WebSocket protocol evidence; it does not certify browser rendering, keyboard/touch controls, graphics or audio. Skipped, cancelled, failed or missing smoke is unverified.

Before deployment operations, read [agent operations](docs/agent-operations.md). Never apply unrelated staged Railway patches; fallback deploys must name the exact merged SHA. World persistence requires the reviewed production volume and `GEOROIDS_WORLD_PATH=/data/world.sqlite`; apply that configuration before server deployment. The game loop never waits for disk writes. Production configuration and destructive data changes remain human-owned.

## Project

GeoRoids — a cooperative open-world multiplayer spaceship game (surveying, asteroid towing, shared furnace deliveries). Astro static pages with Svelte 5 and shadcn-svelte interfaces plus a TypeScript canvas engine (`src/`) talking to a Node WebSocket server (`server.ts` + `server/`) over `ws://`, with rules both sides share in `shared/`. Play the client at <https://www.georoids.com>; the authoritative server runs on Railway (see Deploy). Node `^24.15.0`.

`AGENTS.md` (plus `tests/AGENTS.md`) is the only agent instruction file. Claude Code 2.1.277+ reads it natively; do not add a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md`, because any of them makes Claude Code ignore `AGENTS.md`.

## Frontend stack

Astro owns static `/`, `/debug` and `/wiki` documents and manages Vite. Svelte 5
and committed shadcn-svelte primitives own page and DOM interfaces. TypeScript
owns canvas painting, geometry, simulation and multiplayer. Keep ordinary document navigation, relative
imports and imports from defining modules. Preserve the committed Svelte/shadcn-svelte components and accessible controls.

## Deploy

Astro static client and authoritative WebSocket server deploy independently from `main`. Before configuration or release work, read [deployment operations](docs/agent-operations.md#deploy) and [world operations](docs/persistent-world.md). Never use the retired geoasteroids hostnames. No automatic Vercel Preview deployments: Vercel is production-only. An owner, member or collaborator with repository write access can use a `/preview` PR comment to deploy that PR's head to the single shared Railway `preview` environment, where the game server also serves the built client ([Railway preview](docs/agent-operations.md#railway-preview)). Agents never comment `/preview` or dispatch `Railway Preview` unless John asks. A preview is not release evidence. `railway-preview.yml` deliberately replaces the fleet `vercel-preview.yml` template (completion-matrix row 11) and reuses its matcher; never add `vercel-preview.yml` or `vercel-preview-workflow-contract.sh` here, or one comment would start two previews.

## CI

The repository-owned trusted dispatcher runs the tracked pre-commit gate. The tracked pre-commit hook owns lint, unused-code checks, contracts, types, unit tests, build, complete server integration checks. `npm run gate` invokes that same complete battery with the docs exception disabled. Exact receipts may reuse unchanged validation; candidate reuse requires index parity. The repository pins and checksum-verifies its own actionlint/ShellCheck releases.

## Commands

Run `npm run gate` before publication. Testing instructions, suite ownership, runner isolation and manual browser smoke policy live in [tests/AGENTS.md](tests/AGENTS.md). Read [commands](docs/agent-operations.md#commands) before operating local services.

## Architecture

Astro serves and builds the static client with Vite; the Node WebSocket server owns authoritative world state. Shared gameplay rules live once under `shared/`; import them on both sides. Gameplay requires snapshot v3 and asteroid interactions; unsupported clients must reject, with no protocol opt-outs. Reconnects use private resume tokens. Read [architecture and diagnostics](docs/agent-operations.md#architecture) for module ownership and debugging.

## Tests

Read [tests/AGENTS.md](tests/AGENTS.md) for all testing instructions.

## Project conventions

- **Keep the Wiki current when features change.** When adding, changing, or removing a feature, review the in-game Wiki at `/wiki/` and update affected controls, behavior, setup, and troubleshooting pages in the same work. Follow [manual maintenance](docs/wiki-maintenance.md), including its source-review gate. Remove obsolete instructions and verify links. If no Wiki page is affected, record that explicitly in the change verification. Demonstration media belong to linux-x64; when CI's `wiki-media` lane fails, commit its regenerated baseline after inspection and review ([Generate or verify GIFs](docs/wiki-maintenance.md#generate-or-verify-gifs)).

- **Keep the Wiki brief.** Write two or three short sentences per feature: what to do, what happens, and the essential limitation. Put useful gameplay GIFs beside the explanation. Link to the owning topic instead of repeating instructions; keep exact values and detailed rules in the expandable reference. Preserve this field-guide format when adding features.

- **No barrel files / re-exports** — import from the defining module.
- **Relative paths only** — no `@`-style aliases.
- **No CDN for app assets** — never load runtime CSS or JS from CDNs. Prefer npm, local files, or same-origin Vite/Railway builds.
- **Biome** checks all authored formats it supports, including JavaScript/TypeScript, JSON/JSONC, CSS, HTML, and SVG (`config/quality/biome.settings.jsonc`). It respects `.gitignore` and excludes the generated npm lockfile. Pinned Prettier formats Astro/Svelte documents (`check:format`); `astro check` and `svelte-check` run framework diagnostics. Knip, ts-prune and the unused-member check cover unused code; Markdownlint, Yamllint, actionlint, and ShellCheck cover their respective files. Every enabled lint diagnostic must fail its check, including Knip hints and ShellCheck info/style findings.
- **Production managers use `getInstance()`** (`GameController`, `PlayerManager`, `CollisionManager`, etc.). `GameController` supplies PlayerManager's complete network capabilities at creation; later access cannot rebind them. Isolated runtime tests may construct PlayerManager with explicit capabilities; CollisionManager flashes local collision feedback, reports contact to its caller, and takes none. `src/runtime/gameRuntime.ts` owns production EventLoop wiring and disposal. The Svelte shell owns its mount lifetime.
- **The 60 Hz game loop never touches the disk or does O(world) work.** The saved world is read once at startup and lives in memory; changes leave the loop once a second as a batch through `WorldPersistence` (`server/world/`); unchanged-membership asteroid sectors persist drift every `WORLD.driftFlushCheckpoints` checkpoints. Do not add SQLite calls, `fs` calls, or per-saved-sector scans to `advanceOneFrame` or the message handlers; `tests/unit/server/explored-world-keeps-the-simulation-frame-off-the-database.test.ts` and `world-writes-leave-the-game-loop-once-a-second.test.ts` fail if the loop reaches the disk. The work half has its own guard: an ordinary frame owes the asteroid belt exactly one motion pass, and only the once-a-second frame may cost more — 7 belt copies in production, where `ensureAsteroidField` and `checkpointWorld` both land. `tests/unit/server/the-frame-walks-the-asteroid-belt-once.test.ts` counts a whole second in both world shapes, with and without `WorldPersistence`, and counts the ids each tracked-set read considers, so a second full-belt walk in `advanceOneFrame`, a higher once-a-second copy count, or a tracked set grown toward belt size all fail. That note's tables name which maintenance points the guard rejects and which it cannot. Inside the frame, reach a rare case through a tracked set or `spatialIndex()`, not `getAllAsteroids()`. See [belt passes per frame](docs/performance/belt-passes-per-frame.md).
- **Snapshots and terrain work stay local.** Snapshots send each player only nearby world entities (loot, projectiles, and other players' pickups within `WORLD.interestRadius`; asteroids within the smaller `WORLD.asteroidInterestRadius` radar circle, widened to the interest square while that pilot's Mineral Scan zooms the camera out; a player's own pickups always ship) (`shared/world.ts`; applied in `server/services/GameStateBroadcaster.ts`, with sectors waking at `WORLD.interestRadius` in `server/world/RegionalAsteroidField.ts`), and the client builds contours in local patches (`src/physics/terrain/terrainSession.ts`). Never broadcast or rebuild the whole world. `tests/unit/server/nearby-asteroid-queries-stay-local-as-the-world-grows.test.ts` guards regional asteroid queries and per-player asteroid row filtering, and `tests/unit/rendering/contours-follow-the-camera-without-dropping-lines.test.ts` guards contour patches; `tests/unit/server/pilots-share-snapshot-preparation-without-sharing-private-rows.test.ts` guards per-player filtering of loot, projectiles and non-owned pickup rows, and `tests/unit/server/satellite-inventory-survives-snapshots-and-brief-disconnects.test.ts` guards own-pickup visibility and stored-inventory privacy.
- **Unused-code ownership.** Knip owns unused files and unused module exports;
  it stops checking a module's individual exports as soon as any resolvable path
  string reaches it (a `package.json` script, a `new URL('./x.mjs', import.meta.url)`,
  a dynamic `import('./x.mjs')`), which covers most runners under `scripts/`. So
  ts-prune owns unused exports for those: `config/typescript/prune.jsonc` sets
  `allowJs` to keep `scripts/**/*.mjs` in its program, and
  `scripts/check-unused-typescript.test.mjs` fails if that drops. Biome's
  `noUnusedPrivateClassMembers` owns unused `private` and `#private` class
  members, and `scripts/check-unused-class-members.mjs` — the gate's
  `check:members` stage, its own stage so that its verdicts do not read as a
  ts-prune failure — owns public methods, fields and accessors, on class
  declarations and class expressions alike, that nothing outside the declaring
  class reaches. Remove one with no references, narrow one used only internally
  to `private` so Biome takes over, or give one a caller.
- **What that member check leaves alone.** It judges `src/`, `server/` and
  `shared/` by directory prefix, so `setup/`, `.railway/`, `benchmarks/`,
  `scripts/` whatever the extension, and the repo-root modules (`server.ts`,
  `shared-types.ts`) all sit outside it, as do test doubles and benchmark
  harnesses that exist to satisfy external shapes. `protected` members are out
  of scope too, and Biome's rule covers only private ones, so an unused
  protected member answers to neither gate; an abstract or `declare` member
  defers to the declaration that implements it. An `override` member does not:
  it was excluded while a base declaration still counted as a use, and once
  that stopped the exclusion was the only thing standing between a public
  member and the gate, so one keyword retired it silently. Properties of plain
  objects and constants have no owner at all, and so is a member spelled with a
  string name rather than an identifier. Each kind is judged by the access that reaches
  it: a field by reads and writes, a getter by reads, a setter by writes — a
  pair shares one symbol, so judging either by every reference would let its
  partner speak for it. What counts is the shape of the reference, not the
  language service's one `isWriteAccess` boolean: a compound assignment and an
  increment read a getter as well as assigning it, and a shorthand `{ value }`
  pattern binds a local, so it only reads. A write is recognised through
  parentheses and a non-null assertion, through a bracket key, and through an
  array or object destructuring pattern or a `for (m.value of …)` initializer
  standing where the assignment lands; recognising only the left operand of a
  bare `=` reported a setter five spellings still assign, and `tsc` rejects
  that remedy with TS2540 or TS7053. A shape the check cannot resolve to an
  access reaches nothing rather than counting as a read, because a default of
  read let a `{@link C.m}` doc comment or an indexed-access type retire a
  member permanently: a gate that cannot tell must report rather than clear. Of the fields the check reports, one
  nothing reads is dead storage however it is written, so its remedy is removal
  rather than a narrowing Biome would then report. No class is skipped for its shape, though, and a
  member is skipped only for being abstract or `declare`: one that extends,
  implements, is extended or is abstract has every other member judged,
  `override` included. The language service links a member to the base or
  interface declaration it implements, and that link is a trap rather than
  coverage — the declaration comes back among the member's references, so
  counting it as a use would let one `implements` clause retire a member
  silently. A reference that is itself a member declaration is therefore not a
  use, which is also why an overload signature and a get/set partner reach
  nothing. An object literal that satisfies a port declares the member the same
  way, so it is not a caller either — while that was missed, the verdict turned
  on whether the implementation was spelled `{ hook() {} }` or
  `{ hook: () => 1 }`, and a port touched only by such a literal cleared a
  member with an audit line claiming a relationship nothing exercises.
- **A member with no reference of its own is cleared only by a type
  relationship.** For each one the check asks the type checker whether a
  structural type the class satisfies declares it and something exercises that
  port, whether an `in` probe tests an object the class could be, whether a
  string names a key of an object that carries it the way `vi.spyOn(target,
  'name')` does, or — for a field only — whether a spread copies an instance of
  the class whole, which reads every own field without leaving a reference at
  any declaration (`src/rendering/beltRenderer.ts` spreads a `Roid`; removing
  such a field would quietly empty the copy — that is the only instance spread
  on this tree, and no member is currently cleared by this rule). A method is reached only by
  calling it, so its port must also offer a call signature; a field is reached
  by reading or assigning it, so an ordinary `number` port reaches one, which is
  how `Ship.tapExtractFrames` is reached through `shared/shipAbilities.ts`. A
  spread clears no method or accessor: a method lives on the prototype and an
  accessor is not an own property, so neither is copied. The check rejects what
  looks like a relationship but is not: a declaration of the same name the class
  does not satisfy, a method port typed so loosely it offers no way to invoke
  anything, an `unknown`, `any` or `object` counterparty that every class is
  assignable to, and a shape nothing ever touches — writing an interface is no
  more a way to quiet this check than deleting a component's call site. Bracket
  access needs no allowance for finding a reference, because the service
  resolves `object['name']()` itself; classifying one does need the allowance
  above, since the reference arrives at the key inside the quotes. Each member kept this way is printed with the relationship and the
  file it was found in, so a run that reports nothing can be audited instead of
  trusted — that audit line is what exposed a dead `SatellitePickup.velocity`
  hiding behind a port no pickup is ever passed to — and
  `scripts/check-unused-class-members.test.mjs` carries a discriminating
  negative for every rule and for every exclusion, each one verified by
  mutation rather than by reading: deleting the rule has to turn the suite red.
  Two guards survive mutation because they are unreachable rather than
  untested — `namesAKey`'s `undefined` early return and `declaresMember`'s
  `parent.name === name` — and the kind list is pinned against `checkableKind`,
  because a kind missing from it is counted as a use and fails open.
- **What that still does not prove.** The evidence may sit anywhere in the prune
  program — `tests/`, `benchmarks/`, `scripts/`, `setup/`, `.railway/` and
  `config/` included — even though classes in those directories are not judged;
  `CanvasManager.getGpuFrameStats` is reached from a benchmark, which is a real
  consumer. And a relationship is not a caller: the check establishes that the
  class satisfies a port something declared, not that any value of the class
  ever flows into it. Asked of every judged member rather than only the ones
  without a reference, the rules would clear about one method in six but roughly
  three fields in five, because a field's type is ordinary — a `number`, a
  shared `Position` — and this codebase deliberately hands entities to `shared/`
  helpers by shape. So a clean run is good evidence for a method and weaker
  evidence for a field, and in neither case a proof. Narrowing that further
  needs to follow values into the positions those types occupy, which risks
  reporting live code and is deliberately not attempted. A spread is the only
  whole-object read the check models, and on this tree it is the only one that
  exists: a serializer, an `Object.values` or an object rest pattern over an
  instance would read every field just as invisibly, so introducing one means a
  field reached only that way is reported. The write side is the same and is
  not modelled at all: `Object.assign(instance, { stored: 1 })` writes the
  field through a fresh inferred property that is no reference to the member,
  so a field written only that way looks wholly unreferenced. Two further
  residuals are known. A
  field written only from OUTSIDE the class and read nowhere is accepted rather
  than reported, because the write is a use and nothing here establishes that
  anything reads it — the alternative reports a field whose only reader is a
  serializer. And a structural port exercised only from a `.svelte` or `.astro`
  file is not seen as exercised, because the program holds no component, so a
  class satisfying it is reported; cover the behavior from a test, as the
  component bullet below requires, and never delete the member. Letting a
  component's names exercise a port instead would be worse: the component index
  attributes every name a component uses to every module it imports, so DOM
  names like `close`, `filter` and `show` would clear unrelated ports.
- **A component's call is not a reference the check can find**, since its
  program resolves no `.svelte` or `.astro` file. It therefore reads the
  components that import a module and reports a member one of them names as
  "only a component reaches it" rather than as dead code; markup counts, because
  two of `WikiScrollMemory`'s ten public methods — `noteScroll` and
  `prepareForTraversal` — are reached only from outside its script block. That
  verdict outranks "make it private", because privatizing a member a component
  calls would break its call site. The answer is a test that proves the
  behavior; `tests/AGENTS.md` still forbids a call-only test written to clear a
  gate. The signal is a name match within an importing module, so a component
  holding an instance it did not import stays invisible: never delete a
  component's call site, or the method behind it, to quiet this check, and rely
  on `svelte-check` to catch it if you do. `WikiScrollMemory.release` is the
  worked example — no TypeScript caller, one call site in `WikiShell.svelte`, and
  the behavior test in
  `tests/unit/wiki/back-returns-to-the-scrolled-field-manual.test.ts` is what
  clears it.
- **Two unused-code blind spots genuinely cannot be closed from here:** a module
  reached by a dynamic `import()` has every export counted as used by both tools
  (`scripts/gate-receipt.mjs`), and a hand-written sibling declaration file wins
  module resolution so its implementation never enters the program at all
  (`scripts/validation-admission.d.mts` hides `scripts/validation-admission.mjs`).
  Adding another `.d.mts` beside a `.mjs` fails the test above.
- **Shared types** go in `shared-types.ts` at repo root, not duplicated per side.
- **Conventional Commits** (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`) with a scope (e.g. `feat(network): ...`).

## Local development

Node24 matches `.nvmrc`. Never attach to another checkout's services or kill listeners by port alone. Use `npm run dev`, `dev:check`, and `dev:kill` for this checkout's interactive session. Before provisioning native dependencies or running a smoke, read [local development](docs/agent-operations.md#local-development). Before `npm run gate` or `npm run dev` in a Claude Code cloud session, run `bash .cursor/install-app.sh` ([cloud sessions](docs/agent-operations.md#cloud-sessions)).

## Local UI verification

Start `npm run dev`; verify at origin `http://127.0.0.1:5173/` (routes `/`, `/debug`, `/wiki`) with no auth, following the basic manual browser smoke in [tests/AGENTS.md](tests/AGENTS.md#basic-manual-browser-smoke). A `/preview` URL is verified the same way at its preview origin. Personal skills are optional helpers.

## Verified-tree CI

PRs run static checks, runner contracts, the complete server integration suites, and Wiki media verification concurrently.
The final `ci` job requires all four lanes to succeed; failed, cancelled, or skipped
lanes fail the aggregate. Each lane has its own exact-tree proof.
Full unit and server integration checks run locally in the review gate. Manual performance measurements remain outside it. Post-merge CI reuses each successful PR lane only
when its recorded checkout tree exactly matches the landed tree, using
the repository-owned `scripts/ci-verified-tree.sh`. Missing proof runs that CI lane;
manual runs always validate. The required `ci` name and deployment triggers stay intact.
Canonical contract: [local CI helper](scripts/ci-verified-tree.sh).

## Dependabot CI

Ordinary Dependabot PR events allocate no validation runners. Only an explicitly
authorized manual maintenance run may apply `ow-ci`, after reviewing the current
same-repository PR head and recording the invocation and head as evidence. Apply
the label after the last push: only that `labeled` event runs real CI. A later
Dependabot push defers again; verify the new head and remove/re-add the label to
validate it. Scheduled or automatic maintenance grants no permission to approve,
rebase, rerun, label or merge dependency PRs. Personal maintenance skills are optional.
Deferred names ending in `-deferred`, skipped checks and absent checks cannot
satisfy required `ci`. Merge only the reviewed current head with successful real
CI. See the repository workflow and [release instructions](docs/development.md).

## Configuration

Move optional top-level tracked settings into `config/<domain>/` or their owner;
keep existing nested configuration with its component. Test configuration may live
under `tests/`. Give each setting one owner and retain minimal native adapters. See [configuration guidance](config/README.md)
for active native exceptions and path/scope verification. Commands select the
canonical owners directly; the native TypeScript entries retain required
framework/loader discovery and Svelte diagnostic scope. This repository owns them.

## Repository ownership

This repo maintains its executable helpers, agent instructions and workflow
contracts. Changes in another repo do not automatically rewrite this one. A
cross-repository migration needs the user's explicit scope, independent review,
and a separate verified PR in each affected repository.

## Git hooks

This repo owns `gate/gate-lib.sh` and `scripts/repo-hooks.py`. Run reviewed
`scripts/setup-agent-environment.sh` on main to install its outside-worktree
pre-commit dispatcher. Never set hooksPath to `.git-hooks`: a branch could then
register executable hooks. See [development and release](docs/development.md).

## Agent environment

Use this repository's AGENTS.md and [development guide](docs/development.md).
Run its reviewed `scripts/setup-agent-environment.sh` for pinned tools and hooks.
No private configuration repo, external instruction import or global skill is
required. Optional personal skills do not change this repository's authority.
