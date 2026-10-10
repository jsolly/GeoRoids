import { pipeToTownSquare } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { rotateVectorInto } from '../rendering/travelCamera';

export interface FurnaceSite {
  readonly id: string;
  readonly name: string;
  readonly position: Readonly<Position>;
}
export interface FurnaceTravelView {
  readonly source: FurnaceSite;
  readonly destinations: readonly FurnaceSite[];
  readonly rotation: number;
}
const MARKER_SIZE = 64;
const MARKER_GAP = 12;
const MAP_PADDING = 52;
// Keep 64px markers at least 44px wide after the whole map is scaled.
const MIN_ZOOM = 0.7;

/** Preserve world bearings and pipe geometry, expanding dense maps to separate targets. */
export function createFurnaceTravelLayout(
  { source, destinations, rotation }: FurnaceTravelView,
  viewportWidth: number,
  viewportWindowHeight: number
) {
  const projectBearing = (position: Position) =>
    rotateVectorInto(
      { x: 0, y: 0 },
      position.x - source.position.x,
      position.y - source.position.y,
      rotation
    );
  const sites = [source, ...destinations].map((site) => ({
    ...site,
    position: projectBearing(site.position),
  }));
  const routes = sites.map((site) => pipeToTownSquare(site.id).map(projectBearing));
  const points = [...sites.map((site) => site.position), ...routes.flat()];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const width = Math.max(...points.map((point) => point.x)) - minX;
  const height = Math.max(...points.map((point) => point.y)) - minY;
  const span = Math.max(1, width, height);
  let nearest = Number.POSITIVE_INFINITY;
  for (let a = 0; a < sites.length; a++) {
    const left = sites[a];
    if (!left) {
      continue;
    }
    for (let b = a + 1; b < sites.length; b++) {
      const right = sites[b];
      if (!right) {
        continue;
      }
      nearest = Math.min(
        nearest,
        Math.max(
          Math.abs(left.position.x - right.position.x),
          Math.abs(left.position.y - right.position.y)
        )
      );
    }
  }
  const viewportHeight = Math.min(viewportWindowHeight * 0.42, 340);
  const fit = Math.max(200, Math.min(viewportHeight, viewportWidth || 320));
  const scale = Math.max((fit - MAP_PADDING * 2) / span, (MARKER_SIZE + MARKER_GAP) / nearest);
  const size = Math.ceil(span * scale + MAP_PADDING * 2);
  const project = (position: Position) => ({
    x: MAP_PADDING + (position.x - minX + (span - width) / 2) * scale,
    y: MAP_PADDING + (position.y - minY + (span - height) / 2) * scale,
  });

  const origin = project(projectBearing(source.position));
  return {
    size,
    markerSize: MARKER_SIZE,
    sites: sites.map((site) => ({ ...site, position: project(site.position) })),
    routes: sites.map((site, index) => ({
      id: site.id,
      points: (routes[index] ?? [])
        .map((point) => {
          const projected = project(point);
          return `${projected.x},${projected.y}`;
        })
        .join(' '),
    })),
    initialScroll:
      size > fit + 1
        ? { x: Math.max(0, origin.x - fit / 2), y: Math.max(0, origin.y - viewportHeight / 2) }
        : { x: 0, y: 0 },
  };
}

/** Own browser gesture mechanics only; Svelte owns the transformed map and bounds. */
export function mountFurnaceMapGestures(
  viewport: HTMLElement,
  onZoom: (zoom: number) => void
): () => void {
  const scope = new AbortController();
  const captures = new Map<number, Element>();
  const on = <K extends keyof HTMLElementEventMap>(
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    capture = false
  ) => viewport.addEventListener(type, handler, { signal: scope.signal, capture });
  let zoom = 1;
  let dragged = false;
  const pointers = new Map<number, Position>();
  const gesture = () => {
    const contacts = [...pointers.values()];
    const first = contacts[0];
    if (!first) {
      return undefined;
    }
    const second = contacts[1];
    return second
      ? {
          x: (first.x + second.x) / 2,
          y: (first.y + second.y) / 2,
          distance: Math.hypot(second.x - first.x, second.y - first.y),
        }
      : { ...first, distance: 0 };
  };
  on('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    if (pointers.size === 0) {
      dragged = false;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Preserve the original button target for taps, and keep drags inside the map.
    if (event.target instanceof Element) {
      event.target.setPointerCapture(event.pointerId);
      captures.set(event.pointerId, event.target);
    }
    if (pointers.size > 1) {
      dragged = true;
    }
  });
  const applyZoom = (
    nextZoom: number,
    anchorX: number,
    anchorY: number,
    deltaX = 0,
    deltaY = 0
  ) => {
    const ratio = nextZoom / zoom;
    const left = (viewport.scrollLeft + anchorX) * ratio - anchorX - deltaX;
    const top = (viewport.scrollTop + anchorY) * ratio - anchorY - deltaY;
    zoom = nextZoom;
    onZoom(zoom);
    viewport.scrollLeft = left;
    viewport.scrollTop = top;
  };
  on('keydown', (event) => {
    if (event.target !== viewport || !['+', '=', '-', '_'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const multiplier = event.key === '+' || event.key === '=' ? 1.25 : 1 / 1.25;
    applyZoom(
      Math.max(MIN_ZOOM, Math.min(3, zoom * multiplier)),
      viewport.clientWidth / 2,
      viewport.clientHeight / 2
    );
  });
  on('pointermove', (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const before = gesture();
    if (!dragged && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 5) {
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = gesture();
    if (!before || !after) {
      return;
    }
    dragged = true;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const anchorX = before.x - rect.left - viewport.clientLeft;
    const anchorY = before.y - rect.top - viewport.clientTop;
    const nextZoom =
      before.distance > 0 && after.distance > 0
        ? Math.max(MIN_ZOOM, Math.min(3, (zoom * after.distance) / before.distance))
        : zoom;
    applyZoom(nextZoom, anchorX, anchorY, after.x - before.x, after.y - before.y);
  });
  const release = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    const target = captures.get(event.pointerId);
    captures.delete(event.pointerId);
    if (target?.hasPointerCapture?.(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  };
  on('pointerup', release);
  on('pointercancel', release);
  on('lostpointercapture', release);
  on(
    'click',
    (event) => {
      if (dragged && event.detail !== 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
  return () => {
    if (scope.signal.aborted) {
      return;
    }
    scope.abort();
    pointers.clear();
    for (const [id, target] of captures) {
      if (target.hasPointerCapture?.(id)) {
        target.releasePointerCapture(id);
      }
    }
    captures.clear();
  };
}
