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

P0 coverage:

1. Boundary hit with lives left → one death, clean respawn, brief invuln
2. Laser + low health → explode on that frame (local and remote)
3. Shoot another player → both sockets see the health drop
4. Game-over → known killer, menu after the short overlay (not a long stall)
5. Game clock advances while a ship moves and collides
6. Classic lasers are short shots, not fat discs; a closed tab leaves the board
