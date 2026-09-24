import { ASTEROID_BELT, type BeltRecoveryWarning } from '../../shared/asteroidBelt';
import { asteroidPolygonPoints, findNearestAsteroidImpact } from '../../shared/asteroidReflection';
import type { Position, TerrainSpider } from '../../shared-types';
import type { Roid } from '../entities/roid/Roid';
import { getSpiderField } from '../physics/terrain/spiderSession';
import { canvasManager } from './canvasSurface';

let recovery: readonly BeltRecoveryWarning[] = [];

export function setBeltRecovery(warnings: readonly BeltRecoveryWarning[] = []): void {
  recovery = warnings;
}

function drawCrawler(
  ctx: CanvasRenderingContext2D,
  spider: TerrainSpider,
  host: Roid,
  pilot: Position,
  scale: number,
  time: number
): void {
  const crawler = spider.crawler;
  if (!crawler) {
    return;
  }
  const rock = { ...host, size: host.r, rotation: host.angle };
  const escaping = crawler.phase === 'escaping';
  const hidden = !escaping && findNearestAsteroidImpact(pilot, spider.position, [rock]) !== null;
  const polygon = asteroidPolygonPoints(rock);
  const winding = crawler.phase === 'winding';
  const ink = hidden ? '#71808b' : winding ? '#d2dae3' : '#778391';
  ctx.save();
  ctx.globalAlpha = hidden ? 0.38 : 1;
  ctx.lineWidth = (hidden ? 1 : 1.8) / Math.sqrt(scale);
  ctx.strokeStyle = ink;
  if (hidden) {
    ctx.setLineDash([3 / scale, 4 / scale]);
  }
  // Attached feet follow the outline; an escaping spider folds its legs into the leap.
  for (let leg = 0; leg < 8; leg++) {
    if (escaping) {
      const side = leg < 4 ? -1 : 1;
      const spread = ((leg % 4) - 1.5) * 5;
      const forward = { x: Math.cos(spider.angle), y: Math.sin(spider.angle) };
      const across = { x: -forward.y * side, y: forward.x * side };
      ctx.beginPath();
      ctx.moveTo(spider.position.x + forward.x * spread, spider.position.y + forward.y * spread);
      ctx.lineTo(
        spider.position.x + forward.x * (spread - 8) + across.x * 18,
        spider.position.y + forward.y * (spread - 8) + across.y * 18
      );
      ctx.lineTo(
        spider.position.x + forward.x * (spread + 2) + across.x * 9,
        spider.position.y + forward.y * (spread + 2) + across.y * 9
      );
      ctx.stroke();
      continue;
    }
    const offset = (leg - 3.5) * 0.12 + Math.sin(time * 13 + leg * Math.PI) * 0.035;
    const angle =
      Math.atan2(crawler.anchor.y - host.position.y, crawler.anchor.x - host.position.x) + offset;
    const direction = { x: Math.cos(angle), y: Math.sin(angle) };
    const reach = host.r * 3;
    const contact = findNearestAsteroidImpact(
      { x: host.position.x + direction.x * reach, y: host.position.y + direction.y * reach },
      host.position,
      [rock]
    );
    const foot = contact?.point ?? polygon[0];
    if (!foot) {
      continue;
    }
    const bend = (leg % 2 === 0 ? 1 : -1) * 11;
    ctx.beginPath();
    ctx.moveTo(spider.position.x, spider.position.y);
    ctx.lineTo(
      (spider.position.x + foot.x) / 2 - direction.y * bend,
      (spider.position.y + foot.y) / 2 + direction.x * bend
    );
    ctx.lineTo(foot.x, foot.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.translate(spider.position.x, spider.position.y);
  ctx.rotate(spider.angle);
  const crouch = winding ? 1 - crawler.progress * 0.3 : 1;
  ctx.scale(crouch, crouch);
  ctx.fillStyle = '#030407';
  ctx.beginPath();
  ctx.ellipse(-5, 0, 12, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(8, 0, 7, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = hidden ? ink : '#e34b5e';
  ctx.shadowColor = '#c91e39';
  ctx.shadowBlur = hidden ? 0 : 5 / scale;
  ctx.fillRect(11, -4, 3, 2);
  ctx.fillRect(11, 2, 3, 2);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#a64554';
  if (winding && !hidden) {
    ctx.beginPath();
    ctx.moveTo(20, -8);
    ctx.lineTo(28 + crawler.progress * 15, 0);
    ctx.lineTo(20, 8);
    ctx.stroke();
  }
  if (!hidden && spider.health < spider.maxHealth) {
    ctx.fillRect(-16, -18, (32 * spider.health) / spider.maxHealth, 2 / scale);
  }
  ctx.restore();
}

/** Draw after asteroids so an occluded crawler remains a faint, distinct silhouette. */
export function drawBeltEncounters(pilot: Position, roids: readonly Roid[]): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const viewport = canvasManager.getViewportSize();
  const scale = canvasManager.getPlayfieldScale();
  const radius = Math.hypot(viewport.width, viewport.height) / (2 * scale);
  const time = performance.now() / 1000;
  ctx.save();
  ctx.translate(viewport.width / 2 - pilot.x * scale, viewport.height / 2 - pilot.y * scale);
  ctx.scale(scale, scale);
  for (const warning of recovery) {
    if (
      Math.hypot(pilot.x - warning.position.x, pilot.y - warning.position.y) >
      radius + warning.size
    ) {
      continue;
    }
    const progress = Math.max(
      0,
      Math.min(1, 1 - (warning.recoverAt - Date.now()) / ASTEROID_BELT.warningMs)
    );
    ctx.save();
    ctx.translate(warning.position.x, warning.position.y);
    ctx.strokeStyle = '#ffc477';
    ctx.fillStyle = '#ffc477';
    ctx.globalAlpha = 0.5 + 0.25 * Math.sin(time * 5);
    ctx.lineWidth = 2 / scale;
    ctx.setLineDash([8 / scale, 6 / scale]);
    ctx.beginPath();
    ctx.arc(0, 0, warning.size + 18 * (1 - progress), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `${12 / scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('REFORMING · KEEP CLEAR', 0, -warning.size - 16 / scale);
    ctx.restore();
  }
  const byId = new Map(roids.map((roid) => [roid.id, roid]));
  for (const spider of getSpiderField().spiders) {
    if (
      !spider.crawler ||
      Math.hypot(pilot.x - spider.position.x, pilot.y - spider.position.y) > radius + 100
    ) {
      continue;
    }
    const host = byId.get(spider.crawler.hostId);
    if (host) {
      drawCrawler(ctx, spider, host, pilot, scale, time);
    }
  }
  ctx.restore();
}
