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
utility latch range share that hull. It has one utility slot. Open the ship schematic with V on desktop, or
press and hold your own hull on touch, to swap **Resource Tap**, **Tow
Cable**, and **Boost Coupling**. Equip is immediate. E still fires the equipped tool; there is no
second ability key. Other pilots cannot open your schematic.

All three tools use the same central mount. The schematic and flying hull show the
equipped hardware: a cable winch and hook, an extraction probe, or a boost nozzle. The animation
preview uses that same Hauler design.

New flights start on Resource Tap. A host that never reports a slot keeps the
legacy Tow Cable so older sessions still haul.

## Resource Tap E

E attaches a tap tether to the nearest living asteroid within a fixed 280-unit
hull gap. The rock briefly shudders on attachment and stays whole. Four cream
canisters with amber tips pop out during extraction, then the tether
releases. The ability never targets a ship. E again releases an unfinished tap,
stopping further drops; canisters already extracted remain collectible.
Furnaces do not consume a tapped rock. With Sound Effects on, each canister leaves
with a low crystal pluck. Collecting canisters answers with brighter notes;
several quick pickups form a short melody.

## Boost Coupling E

Equip Boost Coupling, aim the ship in the desired travel direction, and press E
near a living asteroid. On touch, use ARM. Attachment locks the thrust heading
shown by the cream arrow on the rock; it does not start thrust or extract loot.
You can keep flying and turning without changing that locked heading.

Press E again, or IGNITE on touch, to detach and start a three-second burn.
Cream/amber exhaust marks the powered rock. Acceleration is gradual and speed
is capped at 150 world units per second. After the fuel runs out, the exhaust
ends and the asteroid coasts. Walls and impacts still affect its motion, but
the thrust direction never turns with the ship or the spinning rock.

Swap tools before ignition to cancel. Losing the attachment through distance,
death, disconnect, or asteroid destruction also cancels an armed coupling.
After ignition it runs independently of its pilot. Other Haulers cannot attach
to an armed or burning rock. Ignition starts a new three-second ability cooldown.
A powered rock remains an ordinary asteroid hazard and cannot deliver itself to
a furnace; delivery still requires Tow Cable after the burn.

Burn time follows the simulation, which pauses when nobody is playing. A saved
burn resumes with its remaining fuel when its sector is loaded after restart.

## Tow cable E

E attaches a tow cable to the nearest living asteroid within a fixed 280-unit
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
asteroid, both rocks use the ordinary collision break and the cable detaches.
If it overlaps another ship, that ship takes a normal asteroid impact, the cargo
breaks, and the cable detaches. The Hauler stays unharmed by its own cargo,
including when that cargo is the rock that hits another deposit. Spawn protection
still prevents the ship impact. Untowed rocks pass through each other.

Fly the towed asteroid into an arena furnace to deliver it. The furnace is a
dashed delivery ring around a burning grate with a column of flame roaring up
its middle. Delivery consumes the rock and awards the Hauler. If a Surveyor
scanned the rock, the Hauler and each Surveyor contributor receive identical
delivery points.

Hauler passive exploration reaches 260 world units and contributes to the same
persistent crew chart as Surveyor. Use the shared chart to follow discovered
furnace markers; the local radar shows a discovered furnace while it is within
the nearby radar view, and the universe map keeps its exact landmark anywhere
in the explored world.

## Mining lasers

Hauler deals double mining damage to metal asteroids and cooperative large rocks.
Metal takes two hits instead of three. Small ice and rubble already break in
one hit. The different-pilot requirement for cooperative large-rock splits
remains unchanged. Lasers mine asteroids only; they cannot damage teammates.

## Satellite inventory

Loose satellites enter your ship inventory when collected. Open the schematic
with V or press and hold your hull on touch, then choose Equip. One satellite
orbits at a time, identifying nearby asteroids until its health runs out.
Health drains with time and damage; stored satellites preserve their health. This uses a separate equipment
slot and leaves your core ability available.
