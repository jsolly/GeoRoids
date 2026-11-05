import { probePosition } from '../../shared/surveyProbe';
import { SPIDER, spiderHash, spiderScale } from '../../shared/terrainSpider';
import type { Position, SpiderFieldState, TerrainSpider } from '../../shared-types';
import { updateSpiderScore } from '../audio/spiderScore';
import { clientPerformance } from '../diagnostics/performanceMetrics';
import { drawSurveyProbe } from '../entities/roid/surveyProbeRenderer';
import type { ContourLevel } from '../physics/terrain/contours';
import { getSpiderField, spiderDanger } from '../physics/terrain/spiderSession';
import { getTerrainContours } from '../physics/terrain/terrainSession';
import { canvasManager } from './canvasSurface';
import { createContourQuery } from './contourSpatialIndex';
import type { PlayfieldSize } from './playfieldCamera';
import { spiderFootContacts } from './spiderFootContacts';

interface SpiderRenderState {
  health: number;
  flashUntil: number;
  infestationCandidates: ReturnType<typeof createContourQuery>;
  footCandidates: ReturnType<typeof createContourQuery>;
  pathSegments: ReadonlyArray<readonly ContourLevel['segments'][number][]>;
  path: Path2D | null;
}

// One pair of queries and one current path per live spider; departed IDs are
// pruned every frame. Different guards must not replace each other's rectangle.
const renderStates = new Map<string, SpiderRenderState>();

function drawInfestedContours(
  ctx: CanvasRenderingContext2D,
  spider: TerrainSpider,
  time: number,
  scale: number,
  levels: readonly ContourLevel[],
  state: SpiderRenderState
): void {
  const { x, y } = spider.position;
  const radius = SPIDER.INFLUENCE_RADIUS;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineWidth = 1.4 / scale;
  ctx.strokeStyle = `rgba(236,58,83,${0.7 + 0.15 * Math.sin(time * 3)})`;
  const candidates = levels.map((_, ordinal) =>
    state.infestationCandidates(levels, ordinal, {
      x,
      y,
      width: radius * 2,
      height: radius * 2,
      scale: 1,
      pad: 0,
    })
  );
  if (
    !state.path ||
    candidates.length !== state.pathSegments.length ||
    candidates.some((segments, ordinal) => segments !== state.pathSegments[ordinal])
  ) {
    const path = new Path2D();
    for (const segments of candidates) {
      for (const segment of segments) {
        path.moveTo(segment.ax, segment.ay);
        path.lineTo(segment.bx, segment.by);
      }
    }
    state.path = path;
    state.pathSegments = candidates;
  }
  // Keep the moving clip, pulse and per-spider overlap order live; only geometry
  // submission is retained. Feet continue to project onto these same contours.
  ctx.stroke(state.path);
  ctx.restore();
}

/** Back markings, drawn in the same red as the infested isolines. */
const SPIDER_MARKINGS = ['none', 'stripe', 'chevrons', 'spots'] as const;
type SpiderMarking = (typeof SPIDER_MARKINGS)[number];

/** Render-only silhouette; size comes from the shared hit-radius scale. */
export function spiderLook(id: string) {
  const hash = spiderHash(id);
  return {
    scale: spiderScale(id),
    abdomen: 0.8 + ((hash >>> 7) % 41) / 100,
    head: 0.85 + ((hash >>> 13) % 31) / 100,
    legSpan: 0.85 + ((hash >>> 19) % 36) / 100,
    marking: SPIDER_MARKINGS[(hash >>> 25) % SPIDER_MARKINGS.length] ?? 'none',
  };
}

/** Abdomen markings vary the silhouette; the red always matches the infested isolines. */
function drawBackMarking(
  ctx: CanvasRenderingContext2D,
  marking: SpiderMarking,
  abdomen: number,
  lineWidth: number
): void {
  if (marking === 'none') {
    return;
  }
  const center = -10 * abdomen;
  const half = 16 * abdomen;
  ctx.save();
  ctx.strokeStyle = '#d04c66';
  ctx.fillStyle = '#d04c66';
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  if (marking === 'stripe') {
    ctx.moveTo(center + half * 0.7, 0);
    ctx.lineTo(center - half * 0.7, 0);
    ctx.stroke();
  } else if (marking === 'chevrons') {
    for (const offset of [0.35, -0.05, -0.45]) {
      const x = center + half * offset;
      ctx.moveTo(x - 4, -5);
      ctx.lineTo(x, 0);
      ctx.lineTo(x - 4, 5);
    }
    ctx.stroke();
  } else {
    for (const [dx, dy] of [
      [0.3, -4],
      [0.3, 4],
      [-0.25, 0],
    ] as const) {
      ctx.moveTo(center + half * dx + 1.8, dy);
      ctx.arc(center + half * dx, dy, 1.8, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawSpider(
  ctx: CanvasRenderingContext2D,
  spider: TerrainSpider,
  time: number,
  scale: number,
  levels: readonly ContourLevel[],
  state: SpiderRenderState
): void {
  ctx.save();
  ctx.translate(spider.position.x, spider.position.y);
  ctx.rotate(spider.angle);
  const shudder = Math.min(1, (spider.shudderFrames ?? 0) / 12);
  ctx.translate(Math.sin(time * 95) * 4 * shudder, Math.cos(time * 77) * 3 * shudder);
  ctx.rotate(Math.sin(time * 85) * 0.13 * shudder);
  const variant = spiderLook(spider.id);
  ctx.scale(variant.scale, variant.scale);
  // Keep strokes a steady screen weight across size classes.
  const stroke = 1 / variant.scale;
  const speed = spider.phase === 'hunting' ? 24 : 12;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const feet = spiderFootContacts(
    spider,
    levels,
    time,
    variant.scale * variant.legSpan,
    state.footCandidates
  );
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
      const footX = (dx * cosine + dy * sine) / variant.scale;
      const footY = (-dx * sine + dy * cosine) / variant.scale;
      const kneeX = (rootX + footX) / 2 + (1.5 - leg) * 5 + gait;
      const kneeY = (side * 5 + footY) / 2 + side * (12 + Math.abs(gait));
      ctx.beginPath();
      ctx.moveTo(rootX, side * 5);
      ctx.lineTo(kneeX, kneeY);
      ctx.lineTo(footX, footY);
      ctx.strokeStyle = '#170d19';
      ctx.lineWidth = (5 * stroke) / Math.sqrt(scale);
      ctx.stroke();
      ctx.strokeStyle = spider.phase === 'hunting' ? '#ff6075' : '#bd596a';
      ctx.lineWidth = (1.6 * stroke) / Math.sqrt(scale);
      ctx.stroke();
    }
  }
  const flashUntil = spider.health < state.health ? time + 0.18 : state.flashUntil;
  state.health = spider.health;
  state.flashUntil = flashUntil;
  ctx.fillStyle = time < flashUntil ? '#fff0da' : shudder > 0 ? '#8c254e' : '#200e20';
  ctx.strokeStyle = '#d04c66';
  ctx.lineWidth = (1.5 * stroke) / scale;
  ctx.beginPath();
  ctx.ellipse(-10 * variant.abdomen, 0, 16 * variant.abdomen, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawBackMarking(ctx, variant.marking, variant.abdomen, stroke / scale);
  ctx.beginPath();
  ctx.ellipse(9 * variant.head, 0, 11 * variant.head, 9 * variant.head, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffb0b5';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(15 * variant.head, side * 4 * variant.head, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }
  if (spider.health < spider.maxHealth) {
    ctx.fillStyle = '#3b1327';
    ctx.fillRect(-25, -25, 50, (3 * stroke) / scale);
    ctx.fillStyle = '#ff6075';
    ctx.fillRect(-25, -25, (50 * spider.health) / spider.maxHealth, (3 * stroke) / scale);
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
  for (const id of renderStates.keys()) {
    if (!liveIds.has(id)) {
      renderStates.delete(id);
    }
  }
  const radius = Math.hypot(viewport.width, viewport.height) / (2 * scale);
  const levels = getTerrainContours(position, radius + 32 / scale);
  ctx.save();
  canvasManager.applyWorldTransform(ctx, position);
  let visibleSpiders = 0;
  for (const spider of field.spiders) {
    if (
      Math.hypot(position.x - spider.position.x, position.y - spider.position.y) <
      radius + SPIDER.INFLUENCE_RADIUS
    ) {
      if (spider.crawler) {
        continue;
      }
      visibleSpiders++;
      let state = renderStates.get(spider.id);
      if (!state) {
        state = {
          health: spider.health,
          flashUntil: 0,
          infestationCandidates: createContourQuery(),
          footCandidates: createContourQuery(),
          pathSegments: [],
          path: null,
        };
        renderStates.set(spider.id, state);
      }
      drawInfestedContours(ctx, spider, time, scale, levels, state);
      drawSpider(ctx, spider, time, scale, levels, state);
    }
  }
  ctx.restore();
  clientPerformance.recordVisibleSpiders(visibleSpiders);
  for (const spider of field.spiders) {
    if (spider.probe) {
      const screen = canvasManager.worldToScreen(probePosition(spider, spider.probe), position);
      drawSurveyProbe(ctx, spider.probe, screen, scale, Date.now());
    }
  }
  drawSpiderDanger(ctx, viewport, position, field, playerId, alive);
}

/** Audio and the hunted border follow live danger in either world renderer. */
export function drawSpiderDanger(
  ctx: CanvasRenderingContext2D,
  viewport: Readonly<PlayfieldSize>,
  position: Position,
  field: SpiderFieldState,
  playerId: string,
  alive: boolean
): void {
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
