import type { Player } from '../entities/player/Player';
import type { Roid } from '../entities/roid/Roid';
import { interactionTargets } from '../input/objectActions';
import { selectedObjectId } from '../input/touchControls';
import { canvasManager } from './canvasSurface';

/** Draw in HUD coordinates so hit targets and markers agree during Scan zoom. */
export function drawNavigationJourney(
  p: Player,
  roids: readonly Roid[],
  players: readonly Player[]
): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const ship = p.ship;
  const frame = canvasManager.getViewportSize();
  const scale = canvasManager.readInputScale();
  const project = (point: { x: number; y: number }) => ({
    x: frame.width / 2 + (point.x - ship.position.x) * scale,
    y: frame.height / 2 + (point.y - ship.position.y) * scale,
  });
  ctx.save();
  for (const object of interactionTargets(p)) {
    const at = project(object.position);
    ctx.strokeStyle =
      object.id === selectedObjectId() ? 'rgba(134,218,225,0.75)' : 'rgba(134,218,225,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, Math.max(8, object.radius * scale + 4), 0, Math.PI * 2);
    ctx.stroke();
  }
  const destination = ship.navigation?.destination;
  if (destination) {
    const end = project(destination);
    ctx.strokeStyle = 'rgba(175,226,242,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    ctx.beginPath();
    ctx.moveTo(frame.width / 2, frame.height / 2);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(end.x, end.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    const dx = destination.x - ship.position.x,
      dy = destination.y - ship.position.y,
      len2 = dx * dx + dy * dy;
    let first: Roid | null = null;
    let firstAt = Infinity;
    for (const rock of roids) {
      const along =
        len2 > 0
          ? ((rock.position.x - ship.position.x) * dx + (rock.position.y - ship.position.y) * dy) /
            len2
          : 0;
      if (along <= 0 || along > 1 || along >= firstAt) {
        continue;
      }
      if (
        Math.hypot(
          rock.position.x - ship.position.x - dx * along,
          rock.position.y - ship.position.y - dy * along
        ) <
        rock.r + ship.r
      ) {
        first = rock;
        firstAt = along;
      }
    }
    if (first) {
      const at = project(first.position);
      ctx.strokeStyle = '#eeb578';
      ctx.beginPath();
      ctx.arc(at.x, at.y, (first.r + ship.r) * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  for (const pilot of players) {
    if (pilot.ship.shieldFrames > 0) {
      const at = project(pilot.ship.position);
      ctx.strokeStyle = '#91dcff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(at.x, at.y, (pilot.ship.r + 8) * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  if (ship.arrivalFrames > 0) {
    ctx.strokeStyle = `rgba(175,226,242,${ship.arrivalFrames / 12})`;
    ctx.beginPath();
    ctx.arc(frame.width / 2, frame.height / 2, ship.r + (12 - ship.arrivalFrames), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
