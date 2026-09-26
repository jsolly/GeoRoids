import { pipeToTownSquare } from '../../shared/furnaces';
import type { Position } from '../../shared-types';
import { rotateVectorInto } from '../rendering/travelCamera';

type FurnaceSite = { id: string; name: string; position: Position };
const MARKER_SIZE = 64;
const MARKER_GAP = 12;
const MAP_PADDING = 52;

/** Keep world bearings and pipe geometry, expanding the scrollable map when targets get crowded. */
export function renderFurnaceTravelMap(
  container: HTMLElement,
  source: FurnaceSite,
  destinations: readonly FurnaceSite[],
  onTravel: (id: string) => void,
  rotation = 0
): void {
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
  const viewportHeight = Math.min(window.innerHeight * 0.42, 340);
  const fit = Math.max(200, Math.min(viewportHeight, container.clientWidth || 320));
  const scale = Math.max((fit - MAP_PADDING * 2) / span, (MARKER_SIZE + MARKER_GAP) / nearest);
  const size = Math.ceil(span * scale + MAP_PADDING * 2);
  const project = (position: Position) => ({
    x: MAP_PADDING + (position.x - minX + (span - width) / 2) * scale,
    y: MAP_PADDING + (position.y - minY + (span - height) / 2) * scale,
  });
  const viewport = document.createElement('div');
  viewport.className = 'furnace-travel-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute(
    'aria-label',
    'Furnace destination map. Scroll to explore; Tab to choose a furnace.'
  );
  const map = document.createElement('div');
  map.className = 'furnace-travel-map';
  map.style.width = `${size}px`;
  map.style.height = `${size}px`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('furnace-travel-pipes');
  for (const route of routes) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute(
      'points',
      route
        .map((point) => {
          const projected = project(point);
          return `${projected.x},${projected.y}`;
        })
        .join(' ')
    );
    svg.append(line);
  }
  map.append(svg);
  const caption = document.createElement('p');
  caption.className = 'furnace-travel-caption';
  caption.setAttribute('aria-live', 'polite');
  caption.textContent = `You are at ${source.name}.`;
  for (const site of sites) {
    const current = site.id === source.id;
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'furnace-travel-marker';
    const point = project(site.position);
    marker.style.left = `${point.x}px`;
    marker.style.top = `${point.y}px`;
    marker.title = current ? `${site.name} — You are here` : `Travel to ${site.name}`;
    marker.setAttribute('aria-label', marker.title);
    const icon = document.createElement('span');
    icon.className = 'furnace-travel-symbol';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = current ? '◎' : '♨';
    const label = document.createElement('span');
    label.className = 'furnace-travel-label';
    label.textContent = current ? 'Here' : site.name;
    marker.append(icon, label);
    if (current) {
      marker.setAttribute('aria-current', 'location');
      marker.disabled = true;
    } else {
      marker.dataset['furnaceId'] = site.id;
      const describe = () => {
        caption.textContent = `Travel to ${site.name}`;
      };
      marker.addEventListener('focus', describe);
      marker.addEventListener('pointerenter', describe);
      marker.addEventListener('pointerdown', describe);
      marker.addEventListener('click', () => onTravel(site.id));
    }
    map.append(marker);
  }
  viewport.append(map);
  const hint = document.createElement('p');
  hint.className = 'furnace-travel-hint';
  hint.textContent =
    destinations.length === 0
      ? 'No other furnaces are lit yet. Build a furnace to open a route.'
      : 'Select a lit furnace to travel. Scroll the map to explore.';
  container.replaceChildren(viewport, caption, hint);
  // Center the departure furnace on dense maps without smooth motion.
  const origin = project(projectBearing(source.position));
  if (size > fit + 1) {
    viewport.scrollLeft = Math.max(0, origin.x - fit / 2);
    viewport.scrollTop = Math.max(0, origin.y - viewportHeight / 2);
  }
}
