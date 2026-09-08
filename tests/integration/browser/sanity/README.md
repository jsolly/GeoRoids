# Game and interface scenarios

Follow [the test-writing guide](../../../AGENTS.ms) and
[browser execution guidance](../README.md).

These scenarios cover startup, movement, touch controls, rendered HUD behavior,
and recovery from connection or release changes. A test should describe one
player action and its visible result.

Use model state to synchronize setup, then prove the interface named by the
scenario. For example, a leaderboard test must observe the drawn row; reading a
score from the network model alone cannot show that the row fits or updates.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/browser/sanity/ --reporter=verbose
```
