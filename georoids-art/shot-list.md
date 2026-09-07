# GeoRoids Shot List — Assets Still to Make

Priority order. Code-drawn Canvas polish lands first; raster/sprite work is later.

| Pri | Asset | Notes | Status |
| ----- | -------- | ------- | -------- |
| P0 | Palette pass on live draw calls | Ships, roids, lasers, HUD — locked hexes | Code (first PR) |
| P0 | HUD quieting | Kill debug chrome, shrink score, translucent leaderboard, quiet radar | Code (first PR) |
| P0 | Laser intensity cap | Thin stroke + capped glow; no bloom wash | Code (first PR) |
| P1 | Ship outline + thruster polish | Local / remote / bot faction strokes; trail length | Code (first PR) |
| P1 | Roid stroke tiers | 3 sizes × 3 weights, `#94A3B8` outlines | Code (first PR) |
| P2 | Title / enter-game screen art | Richer OK; `accent_ui` `#A78BFA` menus only | Art gen → integrate |
| P2 | Favicon | Local `#5EEAD4` ship glyph on `#000011` | Art gen |
| P3 | Optional nebula background | Low chroma; preserve playfield readability | Art gen → integrate |
| P3 | Sprite ships (optional) | Only if outline sprites beat code triangles | Later pipeline |
| P3 | Muzzle / hit VFX stills | Reference for code particles; capped intensity | Optional ref |

## Not in scope for first visual PR

Full sprite pipeline, 3D look, baked drop shadows, watermarked comps, always-on health numbers, giant centered score.
