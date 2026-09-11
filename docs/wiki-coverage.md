# Field manual coverage

This inventory keeps the `/wiki/` field manual tied to player-visible rules. The
article IDs are stable fragment links; source paths are repository-relative and
are also recorded on each article in src/wiki/content.ts.

## Article inventory

| ID | Category | Coverage |
| --- | --- | --- |
| field-manual | Start here | Arena orientation, five kits, starting a life |
| controls | Start here | Keyboard, mouse, touch, and movement controls |
| dart | Ships | Stats scorecard, boost dash |
| hauler | Ships | Stats scorecard and combat harpoon |
| warden | Ships | Stats scorecard, automatic friendly E projection, reflective F shield |
| skirmisher | Ships | Stats scorecard, normal fire, E three-shot burst |
| quake | Ships | Stats scorecard, fuel-gated shock pulse |
| fuel-growth | Systems | Fuel tank, fuel drops, loot mass, reflective core, shoot-a-drop blast |
| asteroids | Arena | Materials, health, score, rubble fragments, cooperative splits, reflection |
| satellites | Arena | Six EO profiles, hostile patrols, auto-collected Echo and Relay interceptors |
| terrain | Arena | Seeded hills and valleys, contour elevations, uphill/downhill movement, circular boundary, no terrain damage |
| combat-survival | Combat | Damage, shields, faction gate exceptions, lives, respawn, score |
| factions | Combat | ION and EMBER assignment, direct fire, collisions, ricochets, bots |
| hud-network | Systems | Health capsule, HUD values, minimap, settings, reconnect |

## Coverage matrix

| Player question | Article | Primary source families |
| --- | --- | --- |
| How do I move, aim, fire, or use E/F? | controls | src/input/, src/constants/index.ts, input tests |
| Which of the five kits fits my next flight? | Each ship article | src/entities/ship/shipKits.ts, shipAbilities.ts, kit tests |
| What are the exact hull, shot, and E timing values? | Each ship article | Kit data, SHIP_ABILITY.COOLDOWN_FRAMES, constants |
| How do fuel, mass, shards, cores, and kill loot work? | fuel-growth | shared/fuel.ts, shared/shipGrowth.ts, server/core/LootManager.ts |
| What happens when I shoot a loot drop? | fuel-growth, combat-survival | shared/lootBlast.ts, server/core/GameEngine.ts, loot tests |
| Why did an asteroid split, fragment, reflect, or award a score? | asteroids | server/core/AsteroidManager.ts, shared asteroid helpers, split/reflection tests |
| How does a Hauler pull a nearby target? | hauler | src/entities/ship/harpoonField.ts, ship ability tests |
| Which satellite am I facing and what does a pickup do? | satellites | shared/eoSatellites.ts, satellite managers, pickup collision tests |
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
- Keep section media IDs in sync with src/wiki/media.ts and place each
  demonstration beside the section that explains its mechanic. The
  `mediaForArticle` helper derives the aggregate list used by coverage checks.
  Requested demonstrations
  include ship abilities, movement, reflection, cooperative splits, shields,
  Hauler harpoon, reflective asteroids, satellites, pickups, terrain slope, and
  loot blast or growth.
- When gameplay source changes, review the affected article and demonstration
  before accepting a new docs/wiki-source-review.json digest. Run the normal
  TypeScript, lint, Markdown, wiki, and relevant gameplay checks from the
  checkout root.

## Known rule discrepancies and maintenance notes

- The ordinary Hauler E uses a view-aware reach with a 280-unit minimum and
  prefers a valid asteroid in reach over a hostile ship. Same-faction ships,
  shielded ships, exploding ships, and dead entities are rejected. A miss does
  not spend the cooldown. While an asteroid is actively harpooned, it passes
  through that Hauler without collision damage; unrelated asteroids and other
  pilots keep normal collision damage, and the target collides normally again
  after the timer or attachment ends.
- Warden E automatically projects a 3-second shield to the nearest living ally
  in reach, preferring the forward hemisphere and then the nearest fallback. It
  reflects hostile lasers but does not stop collisions. Warden F is a separate
  4-second reflective laser shield; other kits' F shield lasts 2 seconds, with a
  6-second cooldown. A shoot-a-drop environmental blast bypasses both; spawn
  protection blocks that blast.
- The authoritative ship-to-asteroid ram currently applies the shared 25-point
  laser hit value. A stale DAMAGE.ASTEROID_COLLISION comment says 100, so the
  manual follows shared/combat.ts and GameEngine.resolveAuthoritativeCombat.
  Boundary damage is 100 and can be survived by a high-health ship.
- Echo and Relay are maintained by the satellite pickup manager and are
  spawned separately from satellite destruction. A nearest living human within
  the automatic collection range claims one; the hardware orbits indefinitely,
  intercepts hostile shots and asteroid collisions, preserves health on owner
  release, and respawns loose and healthy after breaking.
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
