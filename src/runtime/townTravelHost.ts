import { renderFurnaceTravelMap } from '../ui/furnaceTravelMap';
import { readTownTravelMap, requestFurnaceTravel } from './townStore';

/** Temporary phase-2 host: the retained furnace map alone owns these children. */
export function mountTownTravelHost(host: HTMLElement): { refresh(): void; dispose(): void } {
  let disposed = false;
  let signature = '';
  let stopMap: (() => void) | undefined;
  const scope = new AbortController();
  const refresh = (force = false) => {
    if (disposed) {
      return;
    }
    const { source, destinations, rotation } = readTownTravelMap();
    const next = JSON.stringify([
      source?.id,
      rotation,
      destinations.map(({ id, name }) => [id, name]),
    ]);
    if (!force && next === signature) {
      return;
    }
    signature = next;
    stopMap?.();
    stopMap = undefined;
    if (source) {
      stopMap = renderFurnaceTravelMap(host, source, destinations, requestFurnaceTravel, rotation);
    } else {
      host.replaceChildren();
    }
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    scope.abort();
    stopMap?.();
    host.replaceChildren();
  };
  window.addEventListener('resize', () => refresh(true), { signal: scope.signal });
  try {
    refresh();
  } catch (error) {
    dispose();
    throw error;
  }
  return { refresh: () => refresh(), dispose };
}
