import { isColossalAsteroid } from '../../../shared/asteroidScale';
import { ROID } from '../../constants';

export function pointsForRoidSize(
  size: number
):
  | typeof ROID.POINTS_COLOSSAL
  | typeof ROID.POINTS_LARGE
  | typeof ROID.POINTS_MEDIUM
  | typeof ROID.POINTS_SMALL {
  if (isColossalAsteroid(size)) {
    return ROID.POINTS_COLOSSAL;
  }
  if (size >= ROID.LARGE_MIN_SIZE) {
    return ROID.POINTS_LARGE;
  }
  if (size >= 20) {
    return ROID.POINTS_MEDIUM;
  }
  return ROID.POINTS_SMALL;
}
