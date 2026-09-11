# GeoRoids art pack — acceptance + gaps

**Pack date:** 2026-09-07
**For:** Codex implementation; stalled Cursor work has been recovered and archived.
**Historical hold:** Wave 2 feature merges were held until Hauler cream+tip PASS on a production duo.

## In this ZIP (produced)

### Canon docs

- `style-guide.md` — beauty bar, locked playfield palette, line rules
- `palette-ships-factions.md` — ION/EMBER marks, shield, loot, terrain, harpoon, saucer (temp)
- `ships-and-factions.md` — silhouette v2 LOCKED topology + soft-faction rules
- `hud-treatment.md`, `shot-list.md`, `REFERENCES.md`
- `prompt-sheets-*.md` — paste prompts if regenerating assets
- `eo-satellites/roster-and-briefs.md` — locked 6-bird roster + per-bird tells
- `gauntlet/progress.md` — Wave 1 PASS noted (historical); live Hauler still FAIL
- `priority-first-pr.md`

### Ship silhouettes (PNG sheets — not per-class SVG)

- `ship-silhouettes-contact-v2.png` + `ship-silhouettes-play-scale-v2.png` (canonical)
- `ships-v2/silhouettes-v2.png` + `ships-v2/play-scale-v2.png` (copies)
- v1 drafts also present: `ship-silhouettes-contact.png` (do not bake from v1)

**Locked topology (bake from these, not from imagination):**

1. Dart — needle spike
2. Hauler — cargo barge hex
3. Warden — classic Δ + forward shield arc
4. Skirmisher — deep Y-fork
5. Quake — terraced mountain

### Soft factions (art PASS on marks; code already #465)

- ION mark `#A8A0C8` chevron · EMBER mark `#D4B896` diamond
- Marks only — never full-hull paint
- Ownership strokes stay: local `#5EEAD4` · remote `#7DD3FC` · bot `#FB923C`

### Temp hostile NPC (replace with EO)

- `saucer-npc.svg`, `saucer-npc-firing.svg`, silhouette PNGs — **temp UFO only**

### Harpoon / VFX ref

- `harpoon-vfx-and-hook.png`
- Hex: tether `#E8D5A3` · tip `#FDE68A`
- Product: Hauler-only; same-side mates must **not** latch

### Reviews / screenshots

- `reviews/` — first-paint, pr435, pr465 ion/ember marks

### Palette swatch

- `palette-swatch.png`

---

## Historical source-pack gaps (at recovery time)

The table below records what was absent from the recovered source ZIP. Those statuses are historical; the current ART implementation inventory follows it.

| Ask | Status |
| ----- | -------- |
| **Five ship v2 SVGs** (one file per class) | **Missing in source ZIP** — only contact + play-scale PNG sheets |
| **EO six-bird sprite/SVG assets** | **Missing in source ZIP** — briefs only in `eo-satellites/` |
| **Personality roids ice / metal / rubble** assets | **Missing in source ZIP** — Todoist brief only (`6hR7g44RRHgRx9HF`); no files in pack |
| Per-bird shot manner art | Product TBD; not drawn |
| In-repo bake of hulls from v2 topology | Code/Dev — use PNG sheets until SVGs exist |

## Recovered ART implementation inventory

| Ask | Status in this ART branch |
| ----- | -------- |
| **Five ship v2 SVGs** (one file per class) | **Produced** in `ships-v2/`; traced from the locked v2 outlines and covered by serializer parity tests |
| **EO six-bird SVG assets** | **Produced** in `eo-satellites/`; six distinct hardware outlines and serializer parity tests are present. Runtime call-site wiring belongs to the integrating gameplay branch |
| **Personality roids ice / metal / rubble** assets | **Produced** in `personality-roids/`; contours and facets share the Canvas data and have serializer parity tests |
| Per-bird shot manner art | **Implemented as runtime outline/muzzle geometry**; cadence and projectile behavior are owned by the integrating gameplay branch |
| In-repo bake of hulls and mineral contours | **Complete** in `src/entities/ship/hullOutlines.ts` and `src/entities/roid/materialArt.ts` |

## Current gameplay contract

The forced kits collaboration target is a high-HP (`100`) asteroid. The `asteroidDamage` route applies one canonical laser hit per accepted report; client-supplied damage and points do not change the result. Reaching zero destroys the target and awards the normal drop without entering the one-second collaborative split window. `asteroidDestroyed` reports are not a valid route for this target.

## Acceptance bars for the integrating release

The following bars remain the product checks for the combined client/server release. Any dated PASS/FAIL text below is historical evidence from the named smoke, not the current release result.

### Hauler harpoon (blocks Wave 2 merges)

- PASS only if live: cream tether `#E8D5A3` + tip `#FDE68A` both readable at play zoom
- Latch rock/bot; hold across brief WS flap
- Same-side mates and ships protected by a projected E shield or F shield must **not** latch
- #486 merged; live still FAIL as of last Pilot smoke — Codex owns fresh fix

### Empty belt after reconnect

- Server/client must re-seed asteroids after soft reconnect (`initAsteroids` skip bug)

### EO NPCs (when art lands)

- Tell all six apart at 32–64px
- EO hardware, not UFO disc
- Different shot manners; personal score / ambient — not faction-aligned
- Kill temp saucer when EO pack lands

### Personality roids (when art lands)

- Ice = clean shatter · metal = tougher denser loot · rubble = messy splits
- Same outline DNA, different break language
- Readable in play without new ship classes

### Beauty bar

- Elegant phosphor hairlines, no fills, no grit (Matt-blush)

## Repo landing pattern

Commit under game static dirs (e.g. `client/public/art/` or match existing), with `palette/`, `ships/`, `factions/`, `eo-satellites/`, `roids/`, `vfx/` + `docs/art/*.md`. Todoist is index only.

## Name note

Live soft-faction names are **ION / EMBER**. Some older palette lines still say Lyra/Solara — treat those as aliases for the same hexes; prefer ION/EMBER in code/docs.

## Recovery acceptance

Recovered art and gameplay landed in PRs #493/#499/#500, with final production fixes in #501 (a9755405dcfd546ace3e92b4dc8c3ff53d9bb598). Both client and server release identities were verified. Production checks passed for all five hulls, six EO outlines, three minerals, fixed close scale, mobile abilities and shields, a cream/amber Hauler tether across a physical reconnect, allied-target filtering and portrait/landscape leaderboard fitting. Historical source-pack failures above remain provenance rather than current blockers.

## New asteroid interaction cues

Reflective clusters use flat slate facets with small amber charge cues. Laser cores use an amber diamond/bolt mark and show remaining charges in a passive flight readout. Hauler's basic E harpoon uses one cream `#E8D5A3` cable with an amber `#FDE68A` endpoint. Its attached asteroid passes through the Hauler harmlessly until release. Extra asteroid selection, spin controls, and payload cables have been removed.

## Cloud agents

All eight GeoRoids continuation routines have been deleted and all accessible stalled Cursor runs archived under John's takeover instruction. Codex owns the remaining reflective asteroid and Hauler proposals; there is no scheduled Cursor/Grok resume.
