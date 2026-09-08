# Unit tests

Follow [the test-writing guide](../AGENTS.ms). Unit tests prove deterministic
rules and failure boundaries without starting the game server or a browser.
Group them by feature so the canonical scenario is easy to find.

Use a fresh object graph and fixed inputs. Drive the real rule or state
transition, then assert its observable result. Mock transport, storage, clocks,
or logging only when that boundary is outside the behavior under test.

For example, a protocol scenario sends a malformed command and proves that the
world stays unchanged; a collision scenario resolves a real hit and checks the
identified victim's damage. Constructing an entity and reading back its input
fields does not prove either feature.

Extend an existing scenario when an assertion belongs to the same story. Remove
placeholder and weaker duplicate tests instead of preserving their count.
Browser input and rendered HUD behavior belong in browser integration tests.

Run from the repository root:

```bash
npm test
npx vitest run tests/unit/server/wire-commands-are-decoded-before-game-dispatch.test.ts
```

Do not use raw Vitest for integration paths; those require the repository runner.
