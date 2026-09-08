# Asteroid scenarios

Follow [the test-writing guide](../../../AGENTS.ms) and
[browser execution guidance](../README.md).

These scenarios distinguish collaborative splitting, solo destruction,
non-splitting size classes, and collectible drops. Arrange identified asteroids
and pilots, then fire real shots.

Compare the selected asteroid and its identified fragments or drop across
clients. Do not accept unrelated changes to the total field count as proof that
the intended asteroid split. Arm destruction observers before firing and wait
for the corresponding snapshot before asserting that a drop is present.

Run from the repository root:

```bash
./scripts/test-runner.sh tests/integration/browser/roid/ --reporter=verbose
```
