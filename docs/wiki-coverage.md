# Field manual coverage

This inventory keeps the `/wiki/` field manual tied to player-visible rules. The
article IDs are stable fragment links; source paths are repository-relative and
are also recorded on each article in src/wiki/content.ts.

## Article inventory

| ID | Category | Coverage |
| --- | --- | --- |
| field-manual | Start here | Arena orientation, five kits, starting a life |
| controls | Start here | Keyboard, mouse, touch, movement, direct target and tether controls |
| dart | Ships | Starting hull values, boost dash, regular shield |
| hauler | Ships | Starting hull values, combat harpoon, enhanced tool path |
| warden | Ships | Starting hull values, E damage shield, F laser shield distinction |
| skirmisher | Ships | Starting hull values, normal fire, E three-shot burst |
| quake | Ships | Starting hull values, fuel-gated shock pulse |
| fuel-growth | Systems | Fuel tank, fuel drops, loot mass, reflective core, shoot-a-drop blast |
| asteroids | Arena | Materials, health, score, rubble fragments, cooperative splits, reflection |
| asteroid-tools | Arena | Hauler latch, spin, brake, coupling, release, ownership, reconnect |
| satellites | Arena | Six EO profiles, hostile patrols, Echo and Relay pickups |
| terrain | Arena | Seeded hills and valleys, contour elevations, uphill/downhill movement, circular boundary, no terrain damage |
| combat-survival | Combat | Damage, shields, faction gate exceptions, lives, respawn, score |
| factions | Combat | ION and EMBER assignment, direct fire, collisions, ricochets, bots |
| hud-network | Systems | Health capsule, HUD values, minimap, settings, reconnect |

## Coverage matrix

| Player question | Article | Primary source families |
| --- | --- | --- |
| How do I move, aim, fire, use E/F, or use target and tether controls? | controls | src/input/, src/asteroidTools/, src/constants/index.ts, input and gesture tests |
| Which of the five kits fits my next flight? | Each ship article | src/entities/ship/shipKits.ts, shipAbilities.ts, kit tests |
| What are the exact hull, shot, and E timing values? | Each ship article | Kit data, SHIP_ABILITY.COOLDOWN_FRAMES, constants |
| How do fuel, mass, shards, cores, and kill loot work? | fuel-growth | shared/fuel.ts, shared/shipGrowth.ts, server/core/LootManager.ts |
| What happens when I shoot a loot drop? | fuel-growth, combat-survival | shared/lootBlast.ts, server/core/GameEngine.ts, loot tests |
| Why did an asteroid split, fragment, reflect, or award a score? | asteroids | server/core/AsteroidManager.ts, shared asteroid helpers, split/reflection tests |
| How does a Hauler move one or two asteroids? | hauler, asteroid-tools | shared/asteroidMotion.ts, server/core/AsteroidMotionService.ts, tool tests |
| Which satellite am I facing and what does a pickup do? | satellites | shared/eoSatellites.ts, satellite managers, satellite tests |
| Why did the terrain push or slow my ship? | terrain | src/physics/terrain/, terrain and contour tests |
| What hurts me, protects me, kills me, and resets on respawn? | combat-survival, factions | shared/combat.ts, EntityManager.ts, GameEngine.ts, combat tests |
| What do bots do? | combat-survival, factions | server/ai/botController.ts, authoritative combat tests |
| How do I read the HUD and recover from a disconnect? | hud-network | src/rendering/hud/, ConnectionManager.ts, broadcaster, snapshot protocol |

## Maintenance rules

- Keep article IDs and related IDs resolvable. The five kit IDs must remain
  dart, hauler, warden, skirmisher, and quake; controls is the getting-started
  entry used by the home page.
- Keep every article sources array as plain text paths that exist in the
  checkout. Include the definition that owns an exact value and the test or
  server path that proves important behavior.
- Prefer imports from client and shared definitions for values rendered in
  content. Server-only rules may stay in reviewed prose, but their server
  source must be cited.
- Preserve units. Ship shot intervals are milliseconds; ability, shield,
  explosion, respawn, pickup, and satellite timers are frames unless the text
  converts them using the 60 FPS clock.
- Write the player-visible rule and its failure conditions before adding a tip.
  Do not state a best strategy unless source or a scenario test proves it.
- Keep media IDs in sync with src/wiki/media.ts and place each demonstration
  beside the article that explains its mechanic. Requested demonstrations
  include ship abilities, movement, reflection, cooperative splits, shields,
  Hauler motion, satellites, pickups, terrain slope, and loot blast or growth.
- When gameplay source changes, review the affected article and demonstration
  before accepting a new docs/wiki-source-review.json digest. Run the normal
  TypeScript, lint, Markdown, wiki, and relevant gameplay checks from the
  checkout root.

## Known rule discrepancies and maintenance notes

- The ordinary Hauler E uses a view-aware latch range with a 280-unit minimum
  and prefers a valid asteroid in reach over a hostile ship. The enhanced Q
  tool uses its separate 280-unit physical latch range. They must not be
  collapsed into one rule.
- Warden E is a 3-second normal damage shield. F is a separate 2-second laser
  shield with a 6-second cooldown. A shoot-a-drop environmental blast bypasses
  both; spawn protection blocks that blast.
- The authoritative ship-to-asteroid ram currently applies the shared 25-point
  laser hit value. A stale DAMAGE.ASTEROID_COLLISION comment says 100, so the
  manual follows shared/combat.ts and GameEngine.resolveAuthoritativeCombat.
  Boundary damage is 100 and can be survived by a high-health ship.
- Echo and Relay are maintained by the satellite pickup manager and are
  spawned separately from satellite destruction.
- Damaged ships show a thin floating health capsule above the hull during
  normal play; numeric health text is a debug view. The top-left HUD carries
  lives, score, faction, kit, and fuel.
- The current KeyE Quake path is the fuel-gated shock pulse. Legacy EMP helpers
  remain in the source and should not be used to invent a second player action.
- A laser detonation of any loot kind reaches every nearby live hull, including
  the shooter and allies, and bypasses faction filtering and both shield lanes.
  It deals 40 damage within an 80-unit radius, while spawn protection is the
  exception. It pushes only rocks of size 24 or smaller.
- Normal ship-to-ship collision ticks use the faction damage gate. Satellites
  remain hostile to every faction, and reflected lasers are marked as ricochets
  so they can damage the originating or same-faction pilot.
- Mass pickups use the shared 100-base-health growth curve, not each kit's
  starting health. A small first pickup can lower Hauler's 140 starting maximum;
  increases in the calculated maximum add only that gain to current health.
  Fuel and laser cores take separate collection paths and do not add mass.
- Cooperative splits automatically expire without a second qualifying hit.
  Their fast and heavy shockwaves push ships and asteroids without direct
  damage; metal and rubble follow their own break rules.
- Releasing a Hauler tether carries the ship away with its existing tangential
  velocity; it does not give a stationary primary rock a new launch impulse.
  Freed rocks retain their existing motion. Release drag slows the ship before
  ordinary flight resumes.
