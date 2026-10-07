# Scenario tests

Short, readable stories of GeoRoids mechanics. They run in-process against a real
`GameEngine` (and, where it matters, the shared `Ship` class) — no Playwright,
no 90-second death loops.

`playerLeft` on disconnect already shipped in #444; these tests lock that
behavior in, plus the rest of the P0 mechanics list.

```text
npm test   # vitest run tests/unit/  — includes this folder
```

Local and remote hulls share `Ship`. Combat cases use `describe.each` so both
kinds stay honest. Server cases drive `GameServerWorld` (fake sockets, manual
`tick()`).

Manual `tick()` advances combat frame counters; it does not advance or freeze the
real server clock. Control that clock explicitly when a scenario depends on
reconnect grace, pose age, projectile expiry or saved-flight deadlines. Include
only the world and actors needed for the asserted event.
