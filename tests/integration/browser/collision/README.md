# Browser collision scenarios

Follow [the test-writing guide](../../../AGENTS.ms) and
[browser execution guidance](../README.md).

Arrange identified crew pilots and environmental targets through the local test
controls. Use real input or a real simulation update, then observe the exact
asteroid, boundary, or crew-safety result. Entity presence, movement, and
screenshots alone do not prove an interaction happened.

Keep one canonical scenario per outcome. Observe short-lived projectiles and
notifications before triggering the action, and use bounded waits for the
corresponding authoritative event or rendered change.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/browser/collision/ --reporter=verbose
```
