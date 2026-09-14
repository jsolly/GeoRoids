# GeoRoids ships and factions

The playable roster is Surveyor and Hauler. Surveyor reuses the established
needle geometry; Hauler keeps the barge geometry and cream harpoon cable.
Runtime and SVG geometry live in `src/entities/ship/hullOutlines.ts`.
The current pack is `georoids-art/ships-v2/{surveyor,hauler}.svg`.
Stroke is `#5EEAD4` on `#000011`, with a play-scale target around 32px.

| Kit | Hull | Role |
| --- | --- | --- |
| Surveyor | Six-point needle with an aft notch | Nimble exploration and radar mineral scan |
| Hauler | Seven-point barge with a flat keel | Tow and throw rocks; stronger mining lasers |

Soft factions stay on the factions stream (#465). Names stay **ION** / **EMBER**.
Hull, label and minimap colors indicate faction; marks also use `FACTION_MARK_PAINTERS`:

| Side | Mark | Stroke |
| --- | --- | --- |
| ION | chevron | `#7DD3FC` |
| EMBER | diamond | `#FB923C` |

Ion hulls and names are blue; Ember hulls and names are orange. Bot labels append
“(bot)”. Player type does not change faction colors.

## Harpoon (Hauler only)

- Only the Hauler kit may activate or draw harpoon
- Latch one nearby rock (forward hemisphere preferred, else nearest in range)
- While latched, haul that rock toward the Hauler
- Tether VFX is Hauler only — cream line `#E8D5A3` + amber tip `#FDE68A`
- Never draw the cream harpoon cable on Surveyor

See `src/entities/ship/shipAbilities.ts` and `drawHaulerHarpoonVfx`.

## Surveyor scan

Nearby radar asteroids temporarily use circles for ice, squares for metal,
and triangles for rubble, with a text legend. The hull shows a scan ring.
The normal F shield remains a separate mint ring for both ships.

## EO satellite pickups

The six collectible hulls use the hardware outlines in `eo-satellites/`: Landsat 7, Terra, Aqua, GOES-16, ENVISAT and WorldView-3. Their common neutral lilac hull (`#C4B5FD`) distinguishes them from both factions. Geometry lives in `src/entities/satellite/eoOutlines.ts`; the SVGs use the same paths. The runtime treats these as orbiting pickups rather than firing NPCs.

The source pack contained briefs but no EO vector assets. Codex completed the hardware drawings from those briefs during the September 7 takeover. The recovered UFO discs are historical references and are not the active renderer.

## Mineral asteroids

Ice has clean crystal facets and straight spreading shards. Metal has compact plated facets, survives three Surveyor shots or two Hauler shots, shows progressive cracks and yields a denser shard. Rubble has a broken perimeter and separates into three unequal fragments when large enough. Fragment size and the field cap bound growth. All three retain neutral asteroid ink; none uses faction paint.

`personality-roids/` contains the matching SVGs and a play-scale contact sheet. The server owns composition, health, fragments and rewards; clients render the same material after join or reconnect.
