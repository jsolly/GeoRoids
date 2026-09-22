import type { Position } from '../shared-types';
import { TOWN_HEARTH } from './furnaces';

/** Town Square is the only hearth. Intake, guidance, and spider safety use it. */
export class FurnaceField {
  nearby(position: Position, radius: number): (typeof TOWN_HEARTH)[] {
    return Math.hypot(position.x - TOWN_HEARTH.position.x, position.y - TOWN_HEARTH.position.y) <=
      radius
      ? [TOWN_HEARTH]
      : [];
  }

  nearest(_position: Position): typeof TOWN_HEARTH {
    return TOWN_HEARTH;
  }
}
