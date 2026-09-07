# GeoRoids Style Guide

## Thesis

**Beautiful retro** Atari Asteroids for Canvas 2D multiplayer — not brutal, not ugly, not “programmer CRT.” Stark elegant void, crisp hairline vectors with soft luminous phosphor, calm sparse stars, almost no chrome. Faction color is the only modern upgrade so two humans and bots still read at a glance. Polish bar stays “Matt would blush”: authored, premium, and pretty — never glossy UI fills, never harsh raw arcade grit, never a 3D remake.

## Pillars

1. **Vector first** — Objects are stroked polylines only. No solid fills, no gradients on playfield entities, no glossy panels. Hairline strokes; soft phosphor glow ≤ stroke width.
2. **Stark field** — Playfield is near-black (`#000011`). Sparse cool star *points* (`#8BA3C7`), not a photo starfield. Atmosphere comes from line quality, not nebula washes.
3. **Faction tint, classic bones** — Ship silhouettes stay Asteroids-triangle DNA. Local / remote / bot use locked outline colors; roids stay cool slate outlines. HUD is tiny monospace-feel chrome in corners.

## Beauty bar (not brutal)

Retro means **elegance**: luminous thin lines, quiet negative space, intentional color. It does **not** mean muddy CRT noise, thick chunky strokes, harsh pure-white glare, scanline sludge, or deliberately ugly “authentic arcade” grit. If a frame looks cheap or punishing, soften glow, thin the stroke, and kill chrome before you add effects.

## Ships & soft factions

Also: ambient **hostile EO satellite** NPCs (six distinct hardware silhouettes, lilac `#C4B5FD`) — not faction-aligned. See `ships-and-factions.md`.

Ship classes and soft faction marks are detailed in [`ships-and-factions.md`](ships-and-factions.md). Beauty bar and locked playfield palette above still rule.

**Locked roster v1:** Dart (boost dash, glass) · Hauler (loot magnet, slow) · Warden (longer shield) · Skirmisher (burst/ricochet, glass cannon) · Quake (local contour bump).

**Soft-faction rule:** Two calm space factions (ION / EMBER) auto-balance for friendly-fire-off + collab readability. Marks only — tiny chevron/dot/arc or thruster tip (2–4px). **Not** team mode: no team scoreboards, shared win banners, or full-hull team paints. Personal score still; ownership colors (local / remote / bot) stay primary.

## Perspective

Top-down 2D Canvas orthographic playfield. Emulate vector-monitor language on a raster canvas: crisp polylines, intensity via stroke + tiny glow, wraparound space. Code-drawn triangles and polygons are first-class.

## Palette (locked — multiplayer ownership)

| Role | Hex | Use |
| ------ | ----- | ----- |
| bg | `#000011` | Stark playfield void |
| stars | `#8BA3C7` | Sparse star *points* (not soft blobs) |
| local | `#5EEAD4` | Local ship outline + thruster |
| remote | `#7DD3FC` | Remote human ship outline |
| bot | `#FB923C` | Bot ship outline |
| roid | `#94A3B8` | Roid outlines (subordinate to ships) |
| laser_local | `#FDE68A` | Local shots — short segments / dots, not beams |
| laser_enemy | `#FCA5A5` | Enemy / bot shots |
| hud | `#E2E8F0` | Primary HUD (phosphor near-white) |
| hud_muted | `#64748B` | Secondary HUD / radar ring |
| danger | `#F43F5E` | Low health / kill flash only |
| health | `#4ADE80` | Thin health tick / bar |
| accent_ui | `#A78BFA` | Title / menu only (never in play) |

## Line & light (Atari DNA)

- Hairline, even stroke weight; ships and roids share the same vector language.
- Phosphor glow is a soft outer aura ≤ stroke width — never a bloom wash.
- No solid fills on ships, roids, or lasers. Ever.
- Lasers are short bright segments or points (classic shot dots), not huge beams.
- Thruster: tiny tapered trail in faction color only.
- Roids: irregular closed polylines; three sizes = three scales of the same outline language (stroke weight may tick up slightly with size).
- Do **not** use `#FFFFFF` fills or white bloom that washes the field. Phosphor HUD `#E2E8F0` and hairline vectors are the “white” of this look; ships retain their local, remote, or bot ownership colors.

## Detail budget

In play: almost nothing but lines and points. Title / enter-game may add a quiet wordmark and `accent_ui` — still outline DNA, no glassmorphism.

## Readability rule

At a glance: local cyan-mint vs remote sky vs bot amber. Roids quieter. HUD never larger than the smallest ship glyph. If a frame looks busy, kill chrome before you kill vectors.

## Out of bounds

- Photo / painted starfield or nebula dominating the void
- Solid-filled ships, glossy panels, drop shadows, 3D shading
- Giant centered score; DEBUG yellow aesthetic
- Laser bloom / huge bright beams
- Same color for local, remote, and bots
- Dense opaque leaderboard; “Game Server” under radar
- Modern UI kits, frosted glass, thick strokes, anti-aliased mushy edges pretending to be vectors

## HUD do / don't

**Kill:** giant top-center score; yellow DEBUG MODE; laser bloom; “Game Server” under radar; dense opaque leaderboard; any filled HUD panel.

**Keep / rework:** lives as tiny outline ship glyphs (local color); score as small phosphor text top-left; leaderboard as sparse translucent list (bot amber / human sky names); radar as a hairline muted ring with pin-dot contacts; health as a thin tick or 2px capsule — show `100/100` only on damage or settings.

## Hostile EO satellites (ambient)

Six recognizable Earth-observation satellites in `#C4B5FD`, with `#E9D5FF` shot accents. They are not faction-aligned. Their hardware and shot manners follow `eo-satellites/roster-and-briefs.md`; the former UFO artwork is historical only.

## Harpoon (ability)

Cream tether `#E8D5A3` + latch tip `#FDE68A`. Ability VFX; Hauler only; no sixth player class. See `ships-and-factions.md`.

## References

Direction only — never copy, trace, or ship someone else's art. Never lift a character design.

1. **Atari Asteroids — phosphor vector glow** — [Arcade Blogger](https://arcadeblogger.com/2018/10/24/atari-asteroids-creating-a-vector-arcade-classic/) — Take: thin vectors + soft phosphor, not filled shapes. Apply: ship/roid stroke language.
2. **Vector vs raster Asteroids look** — [Retro Game Deconstruction Zone](https://www.retrogamedeconstructionzone.com/2020/01/graphics-in-early-arcade-games-vector.html) — Take: outlines only; bright points for shots; afterglow, not bloom wash. Apply: laser as dots/segments.
3. **Geometry Wars — silhouette + color ownership** — [Game Developer](https://www.gamedeveloper.com/game-platforms/the-color-and-the-shape-bizarre-creations-on-i-geowars-i-sensible-aesthetic) — Take: faction/enemy color ownership under chaos. Apply: locked multiplayer tints.
4. **Blastemoids — wireframe with capped glow** — [itch.io](https://thetavernarcade.itch.io/blastemoids-html5-game-template) — Take: configurable glow restraint. Apply: glow ≤ stroke.
5. **Top-down combat VFX readability** — [gamineai](https://gamineai.com/blog/top-down-combat-vfx-readability-2026-color-timing-system-busy-screens) — Take: reserve danger hue; cap high-luma coverage. Apply: danger `#F43F5E` sparingly; kill bloom.
