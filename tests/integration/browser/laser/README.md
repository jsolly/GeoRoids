# Laser scenarios

Follow [the test-writing guide](../../../AGENTS.ms) and
[browser execution guidance](../README.md).

A two-pilot shot lifecycle proves that real input creates an owned projectile,
the peer receives the same trajectory, and both clients remove it on expiry. Keep
three-client fanout and mouse firing separate because they exercise distinct
transport and input paths.

Capture projectile IDs before firing and match the new projectile's owner and
motion. Observe received or rendered state; a server log saying that a packet
arrived does not prove that the command was accepted or broadcast.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/browser/laser/ --reporter=verbose
```
