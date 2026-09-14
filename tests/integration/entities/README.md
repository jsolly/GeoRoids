# Entity integration tests

Follow [the test-writing guide](../../AGENTS.md). These scenarios exercise real
interactions between game components without a browser. Arrange a fixed world,
perform a collision, input action, or lifecycle tick, and observe its effect.

Use explicit simulation ticks and fresh state. Keep network delivery and rendered
UI assertions in the integration level that actually exercises those boundaries.
See [integration execution guidance](../README.md) for server ownership and cleanup.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/entities/
```
