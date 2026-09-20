---
title: Surveyor
category: Ships
summary: A nimble scout with shared mineral scans and mobile probe beacons.
order: 30
related:
  - content/wiki/controls.md
  - content/wiki/satellites.md
  - content/wiki/asteroids.md
  - content/wiki/hauler.md
media:
  - heading: Mineral scan
    demo: surveyor
---

## Mineral scan

Surveyor is the winged scout with a dish on the nose. It is the smaller hull
next to Hauler's barge. It turns more quickly than
Hauler and cruises automatically at the same speed. Press Shift or tap Boost for
a stronger burst than Hauler's boost; tap or press again to return to cruise.
The shared [boost tank](/wiki/#controls) drains during use and refills while inactive.
Running it empty stops boost. Activate it again as soon as some charge returns;
boosting interrupts the refill.
Choose Mineral Scan in the ship schematic, then press E or
tap Scan to run a range-limited mineral scan on every teammate's radar for a
limited time. The range is centered on the active Surveyor. Teammates see the
shared classification when the rock is inside their own local radar. Circles mark ice,
squares metal, and triangles rubble. Once a rock is identified, its
classification remains with that rock; unscanned rocks remain ordinary dots.
While the scan is active, a thin cyan radar sweep pulses from the hull to the
edge of the viewport. The sweep is a visual cue and does not expand the scan
range.
The ability has a cooldown and costs no resource.

Surveyor also reveals a 650-unit radius around its hull for the shared
exploration chart. Those cells stay revealed for the match, so the crew can
return to a route or furnace that any Surveyor has charted.

Scan does not push rocks or damage ships. A qualifying scan tags the asteroid
with the Surveyor's ID. If a Hauler later delivers that rock to a furnace, the
Hauler and every Surveyor recorded on the tag receive the same delivery points.
The mineral classification stays with the rock until it is delivered or
removed, even after the active scan ends. The tag is also retained for the
delivery reward.

## Survey probe

Open the ship schematic with V or a long press on your hull, then select
Survey Probe. Press E or tap Probe to fire along your heading. The first
asteroid in range receives a small beacon on its surface. Aim at an unoccupied
rock; a rock already carrying a probe blocks the shot. Walls also block it.
A miss does not consume the cooldown or replace an existing beacon.

The probe moves and rotates with its host. It identifies the host immediately,
then periodically identifies nearby asteroid materials for everyone. A thin
expanding ring shows the scan radius, and a pulsing minimap marker lets Haulers
follow the host through the field. Discovered materials remain identified after
the beacon stops. Probe discoveries also record the launching Surveyor for
furnace delivery credit, just like Mineral Scan.

A green health bar above the probe shows its durability. Any pilot can shoot
the exposed beacon off the surface without first destroying the rock. Aim at
the small diamond; a shot that hits the rock first still mines the rock.
Destroying or delivering the host removes its probe too.

The battery expires after a limited time. An amber warning pulse signals that
it is nearly empty. Each Surveyor can keep a limited number of probes active;
a successful attachment beyond that limit replaces their oldest probe.
Switching tools does not remove existing beacons. Probes are temporary equipment
and do not survive a server restart.

## Satellite inventory

Loose satellites enter your ship inventory when collected. Open the schematic
with V or press and hold your hull on touch, then choose Equip. One satellite
orbits at a time, identifying nearby asteroids until its health runs out.
Health drains with time and damage; stored satellites preserve their health. This uses a separate equipment
slot and leaves your core ability available.
