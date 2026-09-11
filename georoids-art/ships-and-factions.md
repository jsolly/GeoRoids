# GeoRoids — ships and factions (AD v2 bake)

Art-box replica of AD v2 **topology**. John locked silhouette v2 on 2026-09-06
via Game Director. `AD_V2_HULL_BAKE_LOCKED` is **true**. Bake against v2 only —
no v1 silhouettes.

Stroke `#5EEAD4` on `#000011`. Play-scale target ~32px. Matt-blush outline Asteroids.

Canonical sheets (John lock): `ship-silhouettes-contact-v2.png` /
`ship-silhouettes-play-scale-v2.png`. Runtime + SVG source:
`src/entities/ship/hullOutlines.ts`. Pack copies:
`georoids-art/ships-v2/{dart,hauler,warden,skirmisher,quake}.svg`.

Sheet construction (play-scale must still read class at a glance):

- Dart — 6-point needle; two downward tail fins; small inverted-V notch
- Hauler — squat barge; flat keel; vertical sides; single bow apex
- Warden — tall delta with flat aft edges, a shallow triangular notch and detached shield arc
- Skirmisher — tall forked prongs; deep inner valley; two aft tips around a second notch
- Quake — triangular peak, stepped cross ledges and a narrower flat rear stem

## Kits (John lock — exactly five)

There is **no Hook sixth ship class**. Harpoon is a **Hauler-only** ability.

| Kit | Topology | Ability |
| --- | --- | --- |
| Dart | needle — tall thin isosceles; inverted-V notch at aft | Boost dash |
| Hauler | barge hex — wide low polygon; flat keel; faceted bow | **Harpoon** (tether / latch) |
| Warden | Δ + forward shield arc — detached arc above the apex | Shield |
| Skirmisher | Y-fork — two forward prongs; notched aft | Ring fire |
| Quake | terraced mountain — triangular peak, cross ledges, narrow rear stem | Shock pulse |

Soft factions stay on the factions stream (#465). Names stay **ION** / **EMBER**.
Hull, label and minimap colors indicate faction; marks also use `FACTION_MARK_PAINTERS`:

| Side | Mark | Stroke |
| --- | --- | --- |
| ION | chevron | `#7DD3FC` |
| EMBER | diamond | `#FB923C` |

Ion hulls and names are blue; Ember hulls and names are orange. Bot labels append
“(bot)”. Player type does not change faction colors.

## Harpoon (Hauler only)

John lock via Game Director. This **is** the Hauler ability — latch, haul, and
tether VFX. It is not a sixth class and not “VFX-only until Hook.”

- Only the Hauler kit may activate or draw harpoon
- Latch one nearby rock (forward hemisphere preferred, else nearest in range)
- While latched, haul that rock toward the Hauler
- Tether VFX is Hauler only — cream line `#E8D5A3` + amber tip `#FDE68A`
- Never draw the cream harpoon cable on Dart / Warden / Skirmisher / Quake

See `src/entities/ship/shipAbilities.ts` and `drawHaulerHarpoonVfx`.

## Warden shield projection

Warden links to a nearby friendly with a thin mint line (`#7DD3C8`). The recipient
shows the same transparent shield ring as F. Keep the link distinct from the
Hauler's cream cable and amber tip; never fill the shield disc.

## EO satellite NPCs

The six ambient hostiles use the hardware outlines in `eo-satellites/`: Landsat 7, Terra, Aqua, GOES-16, ENVISAT and WorldView-3. Their common neutral lilac hull (`#C4B5FD`) and pale shot accents (`#E9D5FF`) distinguish them from both factions. Geometry lives in `src/entities/satellite/eoOutlines.ts`; the SVGs use the same paths.

The source pack contained briefs but no EO vector assets. Codex completed the hardware drawings from those briefs during the September 7 takeover. The recovered UFO discs are historical references and are not the active renderer.

## Mineral asteroids

Ice has clean crystal facets and straight spreading shards. Metal has compact plated facets, survives three ordinary shots, shows progressive cracks and yields a denser shard. Rubble has a broken perimeter and separates into three unequal fragments when large enough. Fragment size and the field cap bound growth. All three retain neutral asteroid ink; none uses faction paint.

`personality-roids/` contains the matching SVGs and a play-scale contact sheet. The server owns composition, health, fragments and rewards; clients render the same material after join or reconnect.
