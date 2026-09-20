import { probePosition } from '../../shared/surveyProbe';
import { SPIDER } from '../../shared/terrainSpider';
import type { Position, TerrainSpider } from '../../shared-types';
import { updateSpiderScore } from '../audio/spiderScore';
import { drawSurveyProbe } from '../entities/roid/surveyProbeRenderer';
import type { ContourLevel } from '../physics/terrain/contours';
import {
  getSpiderConsumptionEffects,
  getSpiderField,
  spiderDanger,
} from '../physics/terrain/spiderSession';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { canvasManager } from './canvasSurface';
import { contourCandidates } from './contourSpatialIndex';
import { spiderFootContacts } from './spiderFootContacts';

const healthHistory = new Map<string, { health: number; flashUntil: number }>();

function drawInfestedContours(
  ctx: CanvasRenderingContext2D,
  spider: TerrainSpider,
  time: number,
  scale: number,
  levels: readonly ContourLevel[]
): void {
  const { x, y } = spider.position;
  const radius = SPIDER.INFLUENCE_RADIUS;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineWidth = 1.4 / scale;
  ctx.strokeStyle = `rgba(236,58,83,${0.7 + 0.15 * Math.sin(time * 3)})`;
  ctx.beginPath();
  for (const [ordinal] of levels.entries()) {
    const segments = contourCandidates(levels, ordinal, {
      x,
      y,
      width: radius * 2,
      height: radius * 2,
      scale: 1,
      pad: 0,
    });
    for (const segment of segments) {
      ctx.moveTo(segment.ax, segment.ay);
      ctx.lineTo(segment.bx, segment.by);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawSpider(
  ctx: CanvasRenderingContext2D,
  spider: TerrainSpider,
  time: number,
  scale: number,
  levels: readonly ContourLevel[]
): void {
  ctx.save();
  ctx.translate(spider.position.x, spider.position.y);
  ctx.rotate(spider.angle);
  const shudder = Math.min(1, (spider.shudderFrames ?? 0) / 12);
  ctx.translate(Math.sin(time * 95) * 4 * shudder, Math.cos(time * 77) * 3 * shudder);
  ctx.rotate(Math.sin(time * 85) * 0.13 * shudder);
  const speed = spider.phase === 'hunting' ? 24 : 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const feet = spiderFootContacts(spider, levels, time);
  const cosine = Math.cos(spider.angle);
  const sine = Math.sin(spider.angle);
  // The toes slide along existing isolines; only the knees flex above them.
  for (const side of [-1, 1]) {
    for (let leg = 0; leg < 4; leg++) {
      const gait = Math.sin(time * speed + leg * Math.PI + side) * 5;
      const rootX = 12 - leg * 7;
      const foot = feet[(side === -1 ? 0 : 4) + leg];
      if (!foot) {
        continue;
      }
      const dx = foot.x - spider.position.x;
      const dy = foot.y - spider.position.y;
      const footX = dx * cosine + dy * sine;
      const footY = -dx * sine + dy * cosine;
      const kneeX = (rootX + footX) / 2 + (1.5 - leg) * 5 + gait;
      const kneeY = (side * 5 + footY) / 2 + side * (12 + Math.abs(gait));
      ctx.beginPath();
      ctx.moveTo(rootX, side * 5);
      ctx.lineTo(kneeX, kneeY);
      ctx.lineTo(footX, footY);
      ctx.strokeStyle = '#170d19';
      ctx.lineWidth = 5 / Math.sqrt(scale);
      ctx.stroke();
      ctx.strokeStyle = spider.phase === 'hunting' ? '#ff6075' : '#bd596a';
      ctx.lineWidth = 1.6 / Math.sqrt(scale);
      ctx.stroke();
    }
  }
  const previous = healthHistory.get(spider.id);
  const flashUntil =
    previous && spider.health < previous.health ? time + 0.18 : (previous?.flashUntil ?? 0);
  healthHistory.set(spider.id, { health: spider.health, flashUntil });
  ctx.fillStyle = time < flashUntil ? '#fff0da' : shudder > 0 ? '#8c254e' : '#200e20';
  ctx.strokeStyle = '#d04c66';
  ctx.lineWidth = 1.5 / scale;
  ctx.beginPath();
  ctx.ellipse(-10, 0, 16, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(9, 0, 11, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffb0b5';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(15, side * 4, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (spider.health < spider.maxHealth) {
    ctx.fillStyle = '#3b1327';
    ctx.fillRect(-25, -25, 50, 3 / scale);
    ctx.fillStyle = '#ff6075';
    ctx.fillRect(-25, -25, (50 * spider.health) / spider.maxHealth, 3 / scale);
  }
  ctx.restore();
}

export function drawTerrainSpiders(position: Position, playerId: string, alive: boolean): void {
  const ctx = canvasManager.getContext();
  if (!ctx) {
    return;
  }
  const viewport = canvasManager.getViewportSize();
  const scale = canvasManager.getPlayfieldScale();
  const field = getSpiderField();
  const time = performance.now() / 1000;
  const liveIds = new Set(field.spiders.map((spider) => spider.id));
  for (const id of healthHistory.keys()) {
    if (!liveIds.has(id)) {
      healthHistory.delete(id);
    }
  }
  const radius = Math.hypot(viewport.width, viewport.height) / (2 * scale);
  const levels = getTerrainContours(position, radius + 32 / scale);
  ctx.save();
  ctx.translate(viewport.width / 2 - position.x * scale, viewport.height / 2 - position.y * scale);
  ctx.scale(scale, scale);
  for (const spider of field.spiders) {
    if (
      Math.hypot(position.x - spider.position.x, position.y - spider.position.y) <
      radius + SPIDER.INFLUENCE_RADIUS
    ) {
      drawInfestedContours(ctx, spider, time, scale, levels);
      drawSpider(ctx, spider, time, scale, levels);
    }
  }
  for (const effect of getSpiderConsumptionEffects()) {
    const progress = Math.min(1, time - effect.startedAt);
    ctx.save();
    ctx.translate(effect.position.x, effect.position.y - progress * 40);
    ctx.globalAlpha = 1 - progress;
    ctx.strokeStyle = '#ffbd69';
    ctx.fillStyle = '#ef6544';
    ctx.lineWidth = 2 / scale;
    const shrink = 1 - progress;
    for (const side of [-1, 1]) {
      for (let leg = 0; leg < 4; leg++) {
        ctx.beginPath();
        ctx.moveTo((12 - leg * 7) * shrink, 0);
        ctx.lineTo((20 - leg * 12) * shrink, side * 23 * shrink);
        ctx.lineTo((25 - leg * 14) * shrink, side * (30 - progress * 24) * shrink);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.ellipse(0, 0, 22 * shrink + 0.1, 12 * shrink + 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let ember = 0; ember < 7; ember++) {
      ctx.beginPath();
      ctx.arc(
        Math.sin(ember * 7) * 26 * progress,
        -ember * 5 * progress,
        2 * shrink + 0.1,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  for (const spider of field.spiders) {
    if (spider.probe) {
      const screen = canvasManager.worldToScreen(probePosition(spider, spider.probe), position);
      drawSurveyProbe(ctx, spider.probe, screen, scale, Date.now());
    }
  }
  const danger = alive ? spiderDanger(position, field, playerId) : 'quiet';
  updateSpiderScore(danger);
  if (danger === 'hunted') {
    ctx.save();
    ctx.strokeStyle = 'rgba(229,56,82,0.65)';
    ctx.lineWidth = 5;
    ctx.strokeRect(2.5, 2.5, viewport.width - 5, viewport.height - 5);
    ctx.restore();
  }
}
