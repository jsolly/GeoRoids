# Entity integration tests

Follow [the test-writing guide](../../AGENTS.ms). These scenarios exercise real
interactions between game components without a browser. Arrange a fixed world,
perform a collision, input action, or lifecycle tick, and observe its effect.

For example,
[`bots-ram-asteroids-and-respawn.test.ts`](bot-player/bots-ram-asteroids-and-respawn.test.ts)
places bots against identified asteroids, invokes the authoritative collision
resolver, and checks damage, asteroid removal, and the bot's later respawn.
Manually applying damage would not prove that the collision resolver works.

Use explicit simulation ticks and fresh state. Keep network delivery and rendered
UI assertions in the integration level that actually exercises those boundaries.
See [integration execution guidance](../README.md) for server ownership and cleanup.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/entities/
./scripts/test-runner.sh tests/integration/entities/bot-player/bots-ram-asteroids-and-respawn.test.ts
```
