# Integration tests

Tests describe a player or system scenario and prove its outcome. A screenshot,
a connected socket, or a nonzero entity count does not prove a collision, hit,
kill, or respawn.

## Choose the test level

| Level | What belongs here |
| --- | --- |
| `tests/unit/` | Deterministic rules, protocol validation, collision geometry, lifecycle boundaries, and failure handling. Use explicit state and controlled clocks. |
| `tests/integration/server/` | Real socket negotiation, shared authoritative state, reconnects, and server lifecycle. |
| `tests/integration/entities/` | Interactions between entities and input components. |
| `tests/integration/browser/` | Real input, rendered state, HUD feedback, and multiplayer behavior that needs a browser to prove it. |

Keep one canonical browser scenario for each behavior. Extend it when another
assertion belongs to the same player story; do not add another launch-and-shoot
test under a different implementation-oriented name.

## Write a scenario

1. Arrange known participants, factions, positions, and starting state. Use the
   shared lifecycle hooks to reset the world and close every browser page.
2. Perform the real action under test. Fixture controls arrange a scene; they
   must not assign the health, score, death, or other outcome being asserted.
3. Observe the specific result. Match entity/projectile/loot IDs and assert the
   appropriate damage, credited score, death cause, or visible UI change.
4. Wait for an observable condition with a deadline. Start observing transient
   events before acting. A receive log can precede validation, and a destruction
   event can precede the next loot snapshot.

Place unrelated actors outside the scenario's interaction area. Do not rely on
ambient bots to damage a target, on a randomly chosen asteroid to survive, or on
a fixed sleep to make a shot land. Keep deterministic simulation rules in the
lower-level tests instead of adding browser aiming and navigation machinery to
retest them.

Screenshots under `browser/screenshots/` are diagnostic artifacts. Capturing one
is not an assertion that the scenario succeeded.

## Run tests

Use Node 24.15 or newer within major 24 and run commands from the GeoRoids checkout. Install the
pinned Chromium browser once with `npx --no-install playwright install chromium`.

```sh
npm run test:integration
npm run test:integration:browser
npm run test:integration:server
npm run test:integration:entities
./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-hud.test.ts --reporter=verbose
```

Always use `scripts/test-runner.sh` for integration tests. It owns one Vite/server
pair and one serialized Vitest worker, rejects occupied ports, and cleans up its
own processes. Do not run raw Vitest integration commands or another suite
against the same servers. Unit tests run separately with `npm test`.

If another checkout owns the default ports, select an unused pair:

```sh
GEOROIDS_TEST_VITE_PORT=5174 GEOROIDS_TEST_SERVER_PORT=3002 \
  ./scripts/test-runner.sh tests/integration/server/
```

A failed health check, reset, fixture placement, or evidence read must fail the
test. For a timeout, inspect the missed condition and server/browser evidence
before changing a deadline. See [browser fixtures](browser/README.md) for setup
controls and browser-specific guidance.
