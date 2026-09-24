import type { AsteroidMaterial, LootKind } from '../../../shared-types';
import { PALETTE } from '../../constants';
import type { DrawingContext } from '../drawingContext';

type ResourceMapIcon = 'asteroid' | 'satellite' | 'nest' | LootKind;

export function asteroidMapInk(material: AsteroidMaterial | undefined) {
  switch (material) {
    case 'crystal':
      return '#D8B4FE';
    case 'ice':
      return '#A5F3FC';
    case 'metal':
      return '#FDE68A';
    case 'rubble':
      return '#FDBA74';
    case undefined:
      return PALETTE.ROID;
    default: {
      const unexpected: never = material;
      throw new Error(`Unexpected asteroid material: ${unexpected}`);
    }
  }
}

/** Append screen-space paths so dense radar fields can batch a single stroke. */
export function addResourceMapPath(
  ctx: DrawingContext,
  kind: ResourceMapIcon,
  x: number,
  y: number,
  size: number,
  material?: AsteroidMaterial
): void {
  const move = (a: number, b: number) => ctx.moveTo(x + a * size, y + b * size);
  const line = (a: number, b: number) => ctx.lineTo(x + a * size, y + b * size);
  switch (kind) {
    case 'asteroid':
      // All minerals keep this silhouette; only ink and small surface cuts vary.
      move(-0.95, -0.25);
      line(-0.5, -0.9);
      line(0.15, -1);
      line(0.8, -0.55);
      line(1, 0.15);
      line(0.5, 0.85);
      line(-0.25, 1);
      line(-0.85, 0.5);
      ctx.closePath();
      if (size >= 3.5) {
        if (material === 'ice') {
          move(-0.35, -0.5);
          line(0, -0.05);
          line(-0.25, 0.4);
          move(0, -0.05);
          line(0.45, -0.25);
        } else if (material === 'metal') {
          move(-0.45, 0.25);
          line(0.35, -0.4);
          move(-0.1, 0.55);
          line(0.6, -0.05);
        } else {
          move(-0.45, -0.25);
          line(-0.1, -0.4);
          line(0.1, -0.05);
          move(0.25, 0.45);
          line(0.55, 0.3);
        }
      }
      return;
    case 'satellite':
      ctx.rect(x - size * 0.22, y - size * 0.4, size * 0.44, size * 0.8);
      ctx.rect(x - size, y - size * 0.65, size * 0.55, size * 1.3);
      ctx.rect(x + size * 0.45, y - size * 0.65, size * 0.55, size * 1.3);
      move(-1, 0);
      line(1, 0);
      move(0, -0.4);
      line(0, -0.9);
      line(0.3, -1.1);
      return;
    case 'nest':
      for (let spoke = 0; spoke < 8; spoke++) {
        const angle = (spoke * Math.PI) / 4;
        move(Math.cos(angle) * 0.28, Math.sin(angle) * 0.28);
        line(Math.cos(angle), Math.sin(angle));
      }
      for (const radius of [0.55, 0.88]) {
        move(radius, 0);
        for (let spoke = 1; spoke <= 8; spoke++) {
          const angle = (spoke * Math.PI) / 4;
          const middle = angle - Math.PI / 8;
          ctx.quadraticCurveTo(
            x + Math.cos(middle) * size * radius * 0.65,
            y + Math.sin(middle) * size * radius * 0.65,
            x + Math.cos(angle) * size * radius,
            y + Math.sin(angle) * size * radius
          );
        }
      }
      return;
    case 'wreckage':
      // Broken ship hull and a detached panel, rather than another rock.
      move(-0.9, 0.75);
      line(-0.45, -0.8);
      line(0.15, -0.25);
      line(-0.05, 0.1);
      line(0.35, 0.35);
      line(0.05, 0.85);
      ctx.closePath();
      move(0.4, -0.75);
      line(0.95, -0.1);
      line(0.65, 0.2);
      move(-0.55, 0.2);
      line(-0.25, 0.5);
      return;
    case 'shard':
      move(-0.65, 0.7);
      line(-0.3, -0.45);
      line(0.8, -1);
      line(0.6, 0.4);
      line(-0.1, 0.9);
      ctx.closePath();
      if (size >= 4) {
        move(-0.1, 0.9);
        line(0.2, -0.25);
        line(0.8, -1);
      }
      return;
    case 'silk':
      // Three looped strands read as a loose skein at both pickup and radar scale.
      for (const offset of [-0.35, 0, 0.35]) {
        move(-0.7, offset - 0.35);
        ctx.quadraticCurveTo(
          x + size,
          y + (offset - 0.7) * size,
          x + size * 0.65,
          y + (offset + 0.15) * size
        );
        ctx.quadraticCurveTo(
          x - size * 0.4,
          y + (offset + 0.85) * size,
          x - size * 0.7,
          y + (offset - 0.35) * size
        );
      }
      return;
    case 'boost_coupling':
      move(-0.65, -0.75);
      line(0.65, -0.75);
      line(0.45, 0.35);
      line(-0.45, 0.35);
      ctx.closePath();
      move(-0.4, 0.35);
      line(0, 1.1);
      line(0.4, 0.35);
      move(-0.9, -0.3);
      line(0.9, -0.3);
      return;
    case 'survey_probe':
      move(0, -1);
      line(0.55, 0);
      line(0, 0.8);
      line(-0.55, 0);
      ctx.closePath();
      move(-1, -0.55);
      line(-0.7, 0);
      line(-1, 0.55);
      move(1, -0.55);
      line(0.7, 0);
      line(1, 0.55);
      return;
    case 'resource_tap':
    case 'points':
    case 'tap':
      move(-0.55, -0.35);
      line(-0.55, 0.6);
      line(0, 0.95);
      line(0.55, 0.6);
      line(0.55, -0.35);
      ctx.closePath();
      move(-0.25, -0.35);
      line(-0.25, -0.9);
      line(0.25, -0.9);
      line(0.25, -0.35);
      move(-0.55, 0.2);
      line(0.55, 0.2);
      return;
    default: {
      const unexpected: never = kind;
      throw new Error(`Unexpected resource map icon: ${unexpected}`);
    }
  }
}

/** Both maps use these paths; screen size controls only surface detail. */
export function drawResourceMapMark(
  ctx: DrawingContext,
  kind: ResourceMapIcon,
  x: number,
  y: number,
  size: number,
  color: string,
  material?: AsteroidMaterial
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  addResourceMapPath(ctx, kind, x, y, size, material);
  ctx.stroke();
  ctx.restore();
}
