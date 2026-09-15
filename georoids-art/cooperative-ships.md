# GeoRoids cooperative ships

The playable roster is Surveyor and Hauler. Surveyor uses the delta-wing
scout with a forward dish; Hauler uses the cargo yoke with twin towers
and two engine bells. Runtime and SVG geometry live in
`src/entities/ship/hullOutlines.ts`.
The current pack is `georoids-art/ships-v2/{surveyor,hauler}.svg`.
Stroke is `#5EEAD4` on `#000011`, with a play-scale target around 32px.

| Kit | Hull | Role |
| --- | --- | --- |
| Surveyor | Delta-wing scout with a forward dish | Nimble exploration and radar mineral scan |
| Hauler | U-shaped cargo yoke with twin towers | Tow cargo to furnaces; stronger mining lasers |

All players share one crew. Ownership colors identify the
local pilot (teal) and other players (sky). Kit silhouettes identify
their jobs. There are no faction marks or enemy colors on the crew scoreboard.

## Harpoon (Hauler only)

- Only the Hauler kit may activate or draw harpoon
- Latch one nearby rock (forward hemisphere preferred, else nearest in range)
- Preserve cable length and tow the rock; press E again to release
- Deliver to a revealed furnace for shared Hauler and Surveyor rewards
- Tether VFX is Hauler only — cream line `#E8D5A3` + amber tip `#FDE68A`
- Never draw the cream harpoon cable on Surveyor

See `src/entities/ship/shipAbilities.ts` and `drawHaulerHarpoonVfx`.

## Surveyor scan

Surveyed radar asteroids retain circles for ice, squares for metal, and triangles
for rubble. The active scan shows a hull ring and clears shared fog farther than
passive exploration. The local radar shows nearby contacts; the full-screen
universe map shows revealed furnaces and valuable drops across the world.

## EO satellite pickups

The six collectible hulls use the hardware outlines in `eo-satellites/`: Landsat 7, Terra, Aqua, GOES-16, ENVISAT and WorldView-3. Their common neutral lilac hull (`#C4B5FD`) distinguishes them from crew ships. Geometry lives in `src/entities/satellite/eoOutlines.ts`; the SVGs use the same paths. The runtime treats these as orbiting pickups rather than firing NPCs.

The source pack contained briefs but no EO vector assets. Codex completed the hardware drawings from those briefs during the September 7 takeover. The recovered UFO discs are historical references and are not the active renderer.

## Mineral asteroids

Ice has clean crystal facets and straight spreading shards. Metal has compact plated facets, survives three Surveyor shots or two Hauler shots, shows progressive cracks and yields a denser shard. Rubble has a broken perimeter and separates into three unequal fragments when large enough. Fragment size and the field cap bound growth. All three retain neutral asteroid ink; all remain readable beneath the material survey overlay.

`personality-roids/` contains the matching SVGs and a play-scale contact sheet. The server owns composition, health, fragments and rewards; clients render the same material after join or reconnect.
