# GeoRoids — Ships & Factions Palette (additive)

New hex roles only. **Do not rename** locked playfield hexes in `style-guide.md`.

**Ownership first:** `local` / `remote` / `bot` still own player identity on the hull. Faction mark is secondary (2–4px mark or thruster tip). Shield / loot / terrain support VFX and depth — never louder than ships.

## New roles

| Role | Hex | Use |
| ------ | ----- | ----- |
| `faction_a` (ION) | `#A8A0C8` | Cool violet-grey soft mark — chevron/dot/arc or thruster tip only |
| `faction_b` (EMBER) | `#D4B896` | Warm sand soft mark — chevron/dot/arc or thruster tip only |
| `shield` | `#7DD3C8` | Hairline shield arc phosphor (or ownership color @ ~40% opacity) |
| `loot` | `#E8D5A3` | Tiny outline loot diamonds / chips (cream–muted gold) |
| `terrain_contour` | `#5A6B7D` | Muted iso-contour lines (hud_muted / stars family) |

## Locked playfield (unchanged — reference)

| Role | Hex |
| ------ | ----- |
| bg | `#000011` |
| stars | `#8BA3C7` |
| local | `#5EEAD4` |
| remote | `#7DD3FC` |
| bot | `#FB923C` |
| roid | `#94A3B8` |
| laser_local | `#FDE68A` |
| laser_enemy | `#FCA5A5` |
| hud | `#E2E8F0` |
| hud_muted | `#64748B` |
| danger | `#F43F5E` |
| health | `#4ADE80` |
| accent_ui | `#A78BFA` |

## Hierarchy reminder

1. Ownership stroke (local / remote / bot)
2. Class silhouette
3. Faction mark (ION / EMBER)
4. Shield / loot / terrain accents

Faction paints must never replace ownership colors on the full hull.

## Ambient hostile (not faction)

| Role | Hex | Use |
| ------ | ----- | ----- |
| eo_satellite | `#C4B5FD` | Neutral EO satellite hull outline |
| eo_shot | `#E9D5FF` | EO satellite short shot segments |

Not faction-aligned. Do not reuse bot amber or ION/EMBER marks on the hull.

## Harpoon (ability VFX)

| Role | Hex | Use |
| ------ | ----- | ----- |
| harpoon_line | `#E8D5A3` | Tether line (cream/muted gold) |
| harpoon_tip | `#FDE68A` | Tip / latch chevron |

Not faction chrome. Optional slight mix toward firer ownership ≤30%.
