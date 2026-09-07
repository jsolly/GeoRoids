# GeoRoids Prompt Sheets — 2026-09-05 (retro vector revision)

Tool-agnostic. **Georoids Developer** feeds these into an image tool. **Game Art Director** does not generate final game pixels here.

---

## Shared style block (use on every subject)

```text
Beautiful retro Atari Asteroids vector art, Canvas 2D — elegant not brutal. Stark void #000011, sparse star points #8BA3C7, crisp hairline polylines, soft luminous phosphor glow no wider than the stroke, no solid fills, no glossy UI, no muddy CRT grit. Premium authored multiplayer polish; faction tint on outlines only. Not a 3D remake.
```

(~55 words)

---

## Negatives (append to every prompt)

```text
no solid fills, no gradients on ships or roids, no glossy panels, no glassmorphism, no baked drop shadow, no watermark, no UI text unless this is a title asset, no 3D render, no nebula wash, no photo starfield, no thick strokes, no playfield-washing bloom, no #FFFFFF fill bloom, no muddy CRT noise, no harsh scanline sludge, no deliberately ugly arcade grit, no giant centered score, no debug yellow chrome
```

---

## Subjects

### 1. Ship — local (cyan-mint)

```text
{shared style}
Top-down Asteroids-triangle outline ship, hairline stroke and tiny thruster trail in local #5EEAD4, phosphor glow ≤ stroke, pure silhouette, dark #000011 void.
```

### 2. Ship — remote human (sky)

```text
{shared style}
Top-down Asteroids-triangle outline ship, hairline stroke and tiny thruster trail in remote #7DD3FC, same silhouette language as local, cooler sky tint, dark #000011 void.
```

### 3. Ship — bot (amber)

```text
{shared style}
Top-down Asteroids-triangle outline ship, hairline stroke and tiny thruster trail in bot #FB923C, clearly distinct from cyan-mint and sky, dark #000011 void.
```

### 4. Roids — three sizes

```text
{shared style}
Classic Asteroids irregular closed polylines in roid #94A3B8, three size scales of the same outline language, hairline to slightly heavier with size, no fill, subordinate to ships, dark #000011 void.
```

### 5. Laser / muzzle (classic shot dots)

```text
{shared style}
Classic vector shots: short segments or bright points in laser_local #FDE68A and laser_enemy #FCA5A5, tiny muzzle spark, intensity like phosphor points — never a huge beam, never wash the field.
```

### 6. Title / enter-game screen

```text
{shared style}
Quiet title card: optional GeoRoids wordmark in phosphor #E2E8F0, accent_ui #A78BFA for menu ticks only, single local #5EEAD4 outline ship motif, stark #000011 void, sparse stars — still pure vector DNA.
```

### 7. Favicon

```text
{shared style}
Iconic Asteroids-triangle outline glyph in local #5EEAD4 on #000011, hairline, max clarity at 16–32px, no text, no bloom wash.
```

### 8. Background (classic void — preferred over nebula)

```text
{shared style}
Stark playfield void #000011 with sparse cool star points #8BA3C7 only. No nebula, no galaxies, no soft clouds. Emulate vector-monitor black.
```

---

## Variation grid (one variable per line)

1. **Stroke:** hairline vs 1.5× hairline (still thin; never chunky).
2. **Phosphor:** barely-there aura vs soft capped halo (never bloom wash).
3. **Thruster:** stub vs short taper (faction color only).
4. **Roid jag:** gentle facets vs classic jagged Asteroids silhouette (same #94A3B8).
5. **Star points:** very sparse vs lightly denser points (still #8BA3C7, no soft blobs).

---

## Usage note

Paste shared style + subject + negatives. Lock palette hexes. Prefer stills that guide **code-drawn** Canvas vectors; full sprite pipeline stays later.
