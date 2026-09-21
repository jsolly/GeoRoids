---
title: Hauler
category: Ships
summary: A heavy hull with Resource Tap, Tow Cable, and Boost Coupling utilities.
order: 40
related:
  - content/wiki/controls.md
  - content/wiki/satellites.md
  - content/wiki/asteroids.md
  - content/wiki/combat-survival.md
  - content/wiki/loot-growth.md
  - content/wiki/teamwork.md
media:
  - heading: Tow cable E
    demo: hauler
---

## Utility slot

Hauler is the U-shaped cargo yoke with twin forward towers and two engine
bells. On the playfield it is about twice Surveyor's linear hull size, so the
barge reads as a real tug next to the scout. Draw scale, collision, and
utility latch range share that hull. It has one utility slot. Open the ship schematic with V or the Schematic button
on desktop, or press and hold your own hull on touch, to swap **Resource Tap**, **Tow
Cable**, and **Boost Coupling**. Equip is immediate. E still fires the equipped tool; there is no
second ability key. Other pilots cannot open your schematic.

All three tools use the same central mount. The schematic and flying hull show the
equipped hardware: a cable winch and hook, an extraction probe, or a boost nozzle. The animation
preview uses that same Hauler design.

New flights start on Resource Tap. A host that never reports a slot keeps the
legacy Tow Cable so older sessions still haul.

## Resource Tap E

E attaches a tap tether to the nearest living asteroid or spider within a fixed 280-unit
hull gap. The rock briefly shudders on attachment and stays whole. Four cream
canisters with amber tips pop out during extraction, then the tether
releases. The ability never targets a ship. E again releases an unfinished tap,
stopping further drops; canisters already extracted remain collectible.
Furnaces do not consume a tapped rock. With Sound Effects on, each canister leaves
with a low crystal pluck. Collecting canisters answers with brighter notes;
several quick pickups form a short melody.

Tapping a spider extracts collectible spider silk instead of ore. Each spider has a finite silk reserve. Collected bundles stay in your inventory across flights and reconnects. It shudders
and becomes angry at the tapping pilot. Silk has no crafting use yet.

## Boost Coupling E

Boost Coupling cannot attach to spiders. Equip it and press E near a living asteroid. On touch, use ARM.
The cream arrow on the rock points toward its nearest furnace automatically.
Arming does not start thrust or extract loot; your ship's heading does not
control the delivery direction.

Press E again, or IGNITE on touch, to detach and start autonomous delivery.
Cream/amber exhaust marks the powered rock. It continuously steers toward the
nearest furnace, correcting any sideways momentum it had at ignition. Acceleration is
gradual and speed is capped at 150 world units per second. Propulsion continues
until delivery, with no fuel timeout.

On entering a furnace's intake, the rock's outline flashes danger-red as it
shatters, a short smoke poof rises up the grate, and the rock is consumed
exactly once.
The pilots who armed the coupling receive its full delivery value, as do its
recorded Surveyors. Ordinary rocks need one coupling. A colossal deposit stays
armed until two Haulers have coupled; E or IGNITE before that crew is ready
leaves the couplings latched. The owners do not need to stay nearby or connected, and still earn this
delivery if their last life is lost before intake.

Swap tools before ignition to cancel. Losing the attachment through distance,
death, disconnect, or asteroid destruction also cancels an armed coupling;
a second crew coupling on a colossal deposit remains if only one owner leaves.
After ignition it runs independently of its pilots. Other Haulers cannot attach
to an ordinary armed or burning rock. A second Boost Coupling can join an
armed colossal deposit until the crew is complete. Ignition starts a new three-second ability cooldown.
Once ignited, the rock passes through ships, other asteroids, and satellites.
Weapons and blast impulses do not affect it, and it
cannot be scanned, tapped, towed, or coupled again. Existing Surveyor tags still
receive credit. Only furnace intake consumes the self-guided cargo.

Guidance follows the simulation, which pauses when nobody is playing. A saved
powered rock retains its owner and resumes guidance after restart.
Legacy saved finite burns without an owner resume as unpowered rocks.

## Tow cable E

E attaches a tow cable to the nearest living asteroid or spider within a fixed 280-unit
hull gap. The rock briefly shudders when the cable catches. The ability never
targets a ship, and it cannot deal ship damage.

The asteroid keeps its existing motion and trails behind the Hauler as the
Hauler flies under normal thrust and steering. Surveyor and Hauler share the
same cruise speed; Hauler Boost is weaker than Surveyor Boost. Both use the same
limited [boost tank](/wiki/#controls), which refills while inactive. Any available
charge can start another burst, interrupting the refill. The cable only
applies a small correction when it is stretched; it never reels a rock into the
hull or throws it toward a target. A successful attachment starts the
three-second ability cooldown, while pressing E again releases the cable without
waiting for cooldown.
The cable and ability display update when the server confirms the action. If no eligible
rock is in range, the attempt leaves the cable detached and does not start a
cooldown. While towing, the touch button reads Release and stays available.
After release, a new attachment waits for any remaining cooldown. A dead or
removed rock detaches automatically. If the towed asteroid overlaps another
asteroid, both ordinary rocks use the ordinary collision break and the cable
detaches. A towed colossal deposit breaks the other rock and keeps its cables.
If ordinary cargo overlaps another ship, that ship takes a normal asteroid
impact, the cargo
breaks, and the cable detaches. A towed colossal deposit deals that same
impact without breaking. The Hauler stays unharmed by its own cargo,
including when that cargo is the rock that hits another deposit. Spawn protection
still prevents the ship impact. Untowed rocks pass through each other.

A colossal deposit needs two Tow Cables before the cables apply haul force.
One latch holds without moving the rock. Two Haulers who haul it to a furnace
both receive the delivery.

Fly the towed asteroid into a lit furnace to deliver it. Street grates sit
inside one sector so a towed rock can approach from any side. The furnace is a dashed delivery ring around a burning
grate with a column of flame roaring up its middle. Delivery shatters the rock
in a red outline with a short smoke poof and awards the Hauler. If a Surveyor
scanned the rock, the Hauler and each Surveyor contributor receive identical
delivery points.

Hauler passive exploration reaches 260 world units and contributes to the same
persistent crew chart as Surveyor. Use the shared chart to follow discovered
amber furnace markers; the local radar shows a discovered campfire while it is within
the nearby radar view, and the universe map keeps that landmark on the same zoom
scale as the other chart marks. Zoomed out it is a flame pin; the nearby view
keeps the three-tongue campfire.

Tow Cable can also pull a spider behind the Hauler. Drag it into a furnace to
engulf it in flame; with Sound Effects on, nearby pilots hear a brief melodic
whimper as it disappears.

## Mining lasers

Hauler deals double mining damage to metal asteroids, cooperative large rocks,
and colossal deposits.
Metal takes two hits instead of three. Small ice and rubble already break in
one hit. A colossal deposit takes many hits and does not use the one-second
collaboration window; at zero mining health it splits into two large fragments.
The different-pilot requirement for cooperative large-rock splits
remains unchanged. Lasers mine asteroids only; they cannot damage teammates.

## Satellite inventory

Loose satellites enter your ship inventory when collected. Open the schematic
with V or the Schematic button on desktop, or press and hold your hull on
touch, then choose Equip. One satellite
orbits at a time, identifying nearby asteroids until its health runs out.
Health drains with time and damage; stored satellites preserve their health. This uses a separate equipment
slot and leaves your core ability available.
