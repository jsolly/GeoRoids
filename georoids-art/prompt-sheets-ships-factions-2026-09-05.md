# Prompt sheets — Ships & soft factions (2026-09-05)

Tool-agnostic. Generate stills for art review; code remains the source of truth for in-game vectors. No Freepik asset invention — prompts describe original outline shapes only.

---

## Shared style block

```text
Beautiful retro Atari Asteroids Canvas 2D aesthetic. Elegant phosphor vector monitor look, not brutal CRT. Stark near-black void #000011. Outline-only polylines, hairline strokes, soft luminous phosphor glow no wider than the stroke. Top-down orthographic. Crisp thin lines, calm negative space, no solid fills, no gradients on entities, no glossy panels, no photo starfield, no 3D shading. Premium quiet elegance — Matt would blush.
```

---

## Negatives

```text
No solid fills, no thick chunky strokes, no muddy CRT scanline sludge, no harsh pure-white glare, no bloom wash, no nebula, no glossy UI, no glassmorphism, no 3D bevels, no esports banners, no team scoreboards, no full-hull team paint, no chunky loot icons, no opaque shield bubbles, no matching faction ship recolors that erase class silhouette, no Freepik stock characters, no logos.
```

---

## One subject per ship class (top-down outline)

Use shared style + negatives. Stroke in local ownership `#5EEAD4` for contact-sheet consistency unless noted. Background `#000011`. Single ship, centered, no HUD.

### Dart

```text
[SHARED STYLE]
Subject: top-down outline Dart ship — slender needle triangle, elongated nose, minimal wings, tiny rear thruster notch. Hairline phosphor stroke. Smallest silhouette in the roster. Glass / fragile feel.
[NEGATIVES]
```

### Hauler

```text
[SHARED STYLE]
Subject: top-down outline Hauler ship — wide blunt triangle, short nose, heavy aft mass, hairline-to-1.5px phosphor stroke. Largest silhouette. Quiet tank / slow mass feel. Optional faint dashed crescent ahead of nose suggesting loot magnet (hud_muted #64748B).
[NEGATIVES]
```

### Warden

```text
[SHARED STYLE]
Subject: top-down outline Warden ship — balanced classic Asteroids equilateral triangle, subtle shield-notch at nose, even hairline phosphor stroke. Medium size. Tank / longer-shield feel. Optional faint hairline shield arc in #7DD3C8 above the hull.
[NEGATIVES]
```

### Skirmisher

```text
[SHARED STYLE]
Subject: top-down outline Skirmisher ship — forked twin-prong nose on triangle body with open mid-gap, hairline phosphor stroke. Small glass-cannon silhouette. Optional single tiny ricochet spark near a prong tip in laser_local #FDE68A.
[NEGATIVES]
```

### Quake

```text
[SHARED STYLE]
Subject: top-down outline Quake ship — triangle with stepped terraced aft contour (2–3 base steps), hairline phosphor stroke. Medium-large. Optional muted iso-contour ripple lines under the hull in #5A6B7D.
[NEGATIVES]
```

---

## Soft faction mark variants (same hull, mark only)

Keep one hull (e.g. Warden or Dart) in ownership `#5EEAD4`. Change **only** the 2–4px mark / thruster tip.

### Lyra (faction_a)

```text
[SHARED STYLE]
Subject: same top-down outline ship hull as base. Ownership stroke #5EEAD4. Soft faction mark only: tiny 2–4px chevron or pin-dot or hairline arc in cool violet-grey #A8A0C8 on nose or wing root; optional thruster tip tint #A8A0C8. No full-hull recolor.
[NEGATIVES]
```

### Solara (faction_b)

```text
[SHARED STYLE]
Subject: same top-down outline ship hull as base. Ownership stroke #5EEAD4. Soft faction mark only: tiny 2–4px chevron or pin-dot or hairline arc in warm sand #D4B896 on nose or wing root; optional thruster tip tint #D4B896. No full-hull recolor.
[NEGATIVES]
```

---

## Shield VFX still

```text
[SHARED STYLE]
Subject: top-down outline Warden (or Dart) with hairline phosphor shield arc — not an opaque bubble. Arc stroke #7DD3C8 or ownership color at low opacity; soft glow ≤ stroke width. Duration readable, elegant, transparent. Background #000011.
[NEGATIVES]
No filled disc, no frosted dome, no team-colored shield skin.
```

---

## Loot chip still

```text
[SHARED STYLE]
Subject: three tiny outline loot diamonds / chips, 4–6px each, cream–muted gold #E8D5A3, hairline stroke, optional 1px phosphor. Floating on #000011 void. Not chunky icons, not coins, not UI badges.
[NEGATIVES]
```

---

## Variation grid

Generate a 3×3 or 2×5 contact grid on `#000011`:

| Cell | Content |
| ------ | --------- |
| Row A | Dart · Hauler · Warden · Skirmisher · Quake — ownership `#5EEAD4`, no faction mark |
| Row B | Same five with Lyra mark `#A8A0C8` only |
| Row C | Same five with Solara mark `#D4B896` only |
| Extra | Shield arc still · loot chips still · muted terrain contour sample `#5A6B7D` under Quake |

Labels: tiny phosphor HUD text `#E2E8F0` or `#64748B`, never larger than the smallest ship glyph.

---

## Related

- `ships-and-factions.md` — art rules + acceptance
- `palette-ships-factions.md` — additive hex roles
- `style-guide.md` — locked playfield + beauty bar

---

## Hostile saucer / satellite (ambient NPC)

```text
{shared style}
Top-down classic Asteroids flying saucer / satellite NPC, flat ellipse hull with thin equatorial ring, optional short antenna pin, outline-only hairline phosphor stroke in soft lilac #C4B5FD, soft glow ≤ stroke, stark void #000011. Ambient hostile — not a player ship triangle, not faction-marked, not bot amber. Readable silhouette at game size.
```

### Saucer firing

```text
{shared style}
Same lilac saucer silhouette firing short shot segments in saucer_shot #E9D5FF from the rim, classic Asteroids dash length, soft round caps, glow ≤ stroke, never a beam or disc bloom.
```

### Negatives (saucer-specific add-ons)

```text
no triangle ship body, no thruster triangle, no Lyra/Solara faction marks, no bot amber #FB923C hull, no solid fill, no opaque UFO dome, no photoreal saucer, no team chrome
```

> **v2 silhouettes:** Dart=needle spear · Hauler=barge hex · Warden=Δ+shield arc · Skirmisher=deep Y-fork · Quake=terraced mountain. Prefer these over v1 mild triangle deltas.

---

## Harpoon tether + tip

```text
{shared style}
Hairline phosphor harpoon tether in cream #E8D5A3 from a top-down outline ship to a target, tiny open barbed chevron tip in #FDE68A, outline only, soft glow ≤ stroke, stark void. Ability VFX — not faction chrome, not a laser dash volley.
```

### Latched

```text
{shared style}
Same harpoon tether with tip snapped closed (barbed V shut) on enemy ship hull, brief latch tick ring, cream line #E8D5A3, tip #FDE68A, no bloom wash.
```

### Optional Hook class

```text
{shared style}
Top-down outline Hook class: Asteroids triangle body with single asymmetric forward grappling arm / open claw on one shoulder, hairline phosphor #5EEAD4, distinct from Y-fork Skirmisher, stark void.
```

### Saucer (higher-fidelity SVG-ish)

```text
{shared style}
Top-down classic Asteroids hostile saucer as clean SVG vector art: stacked ellipses, equatorial ring with tick marks, small cabin dome with ≤20% soft lilac fill, short antenna dish, rim phosphor #C4B5FD, elegant not brutal, stark void #000011. Higher fidelity than player line-ships — still vector, not photoreal, not 3D.
```

> **Decision:** Harpoon is **Hauler-only**. Hook 6th class rejected.
