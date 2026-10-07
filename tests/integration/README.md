# Code integration tests

Server and entity scenarios prove executed code results without launching a
browser. Use fresh fixed state, explicit target identities and controlled clocks
when elapsed time affects gameplay. Act through the real message, collision,
input or lifecycle boundary; do not assign the outcome being asserted.
Owned loopback tests await actual conditions with bounded cleanup rather than
asserting host speed or relying on fixed sleeps.

## Run

From the absolute GeoRoids checkout directory, use Node 24.15 or newer within
major 24. Browser binaries are not required.

```sh
npm run test:integration
npm run test:integration:server
npm run test:integration:entities
./scripts/test-runner.sh tests/integration/server/server-pause.test.ts --reporter=verbose
```

Always use `scripts/test-runner.sh` for integration paths. It owns one isolated
Vitest worker, per-run artifacts and process cleanup. Individual socket scenarios
create and close their own port-zero loopback servers. The code runner starts no
Vite/server pair and does not consume service-port overrides. Never attach to an
existing developer service. Do not invoke raw Vitest on integration paths.
The default execution deadline is 1200 seconds; timeouts and cleanup failures fail.

Code checks may overlap across different worktrees; the same checkout excludes
validation overlap. `npm run test:integration` runs every file below without
sharding. Browser suites are retired. Native rendering, keyboard/touch delivery
and audio are outside automated coverage. Manual browser benchmarks and Wiki
media tools remain outside the gate.

## Complete inventory

- `tests/integration/entities/input/keybindings.test.ts`
- `tests/integration/entities/input/mouse.test.ts`
- `tests/integration/server/asteroids-follow-debug-placement-policy.test.ts`
- `tests/integration/server/fixture-waits-for-departed-pilots-before-resetting-world.test.ts`
- `tests/integration/server/player-motion-cross-real-sockets.test.ts`
- `tests/integration/server/server-parity.test.ts`
- `tests/integration/server/server-pause.test.ts`
- `tests/integration/server/server-test-reset.test.ts`
