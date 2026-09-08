# Browser collision scenarios

Follow [the test-writing guide](../../../AGENTS.ms) and
[browser execution guidance](../README.md).

Arrange an identified attacker and target through the local test controls. Use
real input or a real simulation update for the hit, then observe the exact
victim, damage, destruction, split, or credited score. Entity presence, movement,
and screenshots alone do not prove a collision happened.

Keep one canonical scenario per outcome. Observe short-lived projectiles and
notifications before triggering the action, and use bounded waits for the
corresponding authoritative event or rendered change.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/browser/collision/ --reporter=verbose
```
