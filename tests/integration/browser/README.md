# Browser scenarios

Browser tests verify real input, rendered state, HUD feedback, and multiplayer
flows. Prefer a short arrange/action/outcome sequence over a general-purpose
combat script. Shared mechanics and exhaustive edge cases belong in deterministic
unit or server tests; see the [test-level guide](../README.md).

## Run

From the GeoRoids checkout:

```sh
npm run test:integration:browser
./scripts/test-runner.sh tests/integration/browser/sanity/game-initializes-with-arena-and-hud.test.ts --reporter=verbose
```

The runner requires unused configured ports and an installed Playwright Chromium
browser. It starts and owns both services. Do not start a second runner or attach
tests to a developer's existing game server.

## Arrange a controlled scene

Use `createBrowserScenarioHooks` for a clean world and fresh pages. Use
`GameInteractions.placeShipAt` for fixture positioning: it updates the server
through the local `/test/place-player` control and waits for the client's motion
epoch acknowledgment. Ordinary gameplay packets still obey movement validation.
The fixture route is loopback-only and returns 404 in production.

Choose explicit hostile/friendly participants and isolate the interaction from
unrelated actors. After setup, use real input and the normal simulation. Do not
write the expected damage, score, death, or pickup into the fixture.

Observe a specific target and result: the same shot on both clients, the exact
victim's health change, a credited kill, or the matched drop disappearing on
collection. Watch transient banners/events before triggering the action. Poll
for snapshots with deadlines instead of assuming an arbitrary delay is enough.

## Organization and evidence

- `sanity/`: startup, controls, responsive UI, release changes, and asteroid tools.
- `e2e/`: complete player and multiplayer scenarios.
- `collision/`: browser-visible combat outcomes.
- `laser/`: real firing input and shared projectile trajectories and cleanup.
- `roid/`: asteroid destruction, cooperative splitting, and collectible drops.

Name each file for its scenario. Keep one canonical test for a behavior and
remove redundant or weaker copies when consolidating it. Screenshots in
`screenshots/` help diagnose failures; they do not establish success by themselves.
