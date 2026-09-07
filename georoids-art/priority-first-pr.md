# First Visual PR — Retro Atari Vector Order

Goal: **beautiful** classic Asteroids feel (elegant phosphor, not brutal/ugly) **without** a sprite pipeline. Keep locked palette for multiplayer ownership.

1. **Stark void** — Ensure playfield is `#000011`; replace photo/soft starfield with sparse star *points* in `#8BA3C7` (or dim the existing bg until it reads as points).
2. **Hairline vectors** — Unify ship + roid stroke to thin even polylines; remove any fills on entities.
3. **Apply locked faction colors** — local `#5EEAD4` / remote `#7DD3FC` / bot `#FB923C` / roid `#94A3B8` on outlines only; thruster trails tiny and faction-tinted.
4. **Classic shots** — Convert lasers to short segments or bright points (`#FDE68A` / `#FCA5A5`); hard-cap glow ≤ stroke; kill huge beams / bloom.
5. **HUD whisper** — Kill DEBUG yellow in production path; shrink score to corner phosphor `#E2E8F0`; translucent sparse leaderboard; hairline radar ring `#64748B`; no “Game Server” label; no filled HUD panels.
6. **Phosphor glow pass** — Soft outer glow ≤ stroke on ships/roids/shots only; no screen-wide bloom.
7. **Later (not this PR)** — Title/enter-game vector card, favicon glyph, optional sprite ships, any nebula experiments (default remains pure void).
