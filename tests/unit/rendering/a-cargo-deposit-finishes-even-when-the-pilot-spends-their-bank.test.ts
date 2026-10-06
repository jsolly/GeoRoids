import { afterEach, expect, test, vi } from 'vitest';
import { Player } from '../../../src/entities/player/Player';
import { MockPlayerInput } from '../../../src/input/MockPlayerInput';
import { canvasManager } from '../../../src/rendering/canvasSurface';
import { drawCargoOffloads } from '../../../src/rendering/cargoOffloadRenderer';
import { setWindowViewport } from '../../support/viewport';

let restoreViewport: (() => void) | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  canvasManager.destroy();
  document.querySelector('#gameCanvas')?.remove();
  restoreViewport?.();
});

test('an accepted final deposit flashes for the pilot and crew even when a purchase lowers their bank', () => {
  document.querySelector('#gameCanvas')?.remove();
  const canvas = document.createElement('canvas');
  canvas.id = 'gameCanvas';
  document.body.append(canvas);
  restoreViewport = setWindowViewport(800, 600);
  canvasManager.initialize();
  const ctx = canvasManager.requireContext();
  const labels = vi.spyOn(ctx, 'fillText');
  const pilot = new Player({
    id: 'cargo-local',
    name: 'Cargo',
    type: 'local',
    input: new MockPlayerInput(),
  });
  const peer = new Player({
    id: 'cargo-peer',
    name: 'Peer',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  for (const player of [pilot, peer]) {
    player.ship.position = { x: 0, y: 0 };
    player.cargo = 25;
    player.score = 500;
  }
  drawCargoOffloads([pilot, peer], pilot.ship.position);
  expect(labels.mock.calls.filter(([text]) => text === 'OFFLOADING · 25 LEFT')).toHaveLength(2);
  labels.mockClear();
  for (const player of [pilot, peer]) {
    player.updateFromServer({ cargo: 0, bankedCargo: 25, score: 425 });
  }
  drawCargoOffloads([pilot, peer], pilot.ship.position);
  expect(labels.mock.calls.filter(([text]) => text === 'CARGO BANKED')).toHaveLength(2);
  const damaged = new Player({
    id: 'damaged',
    name: 'Damaged',
    type: 'remote',
    input: new MockPlayerInput(),
  });
  damaged.ship.position = { x: 0, y: 0 };
  damaged.cargo = 50;
  drawCargoOffloads([damaged], pilot.ship.position);
  labels.mockClear();
  damaged.updateFromServer({ cargo: 0, bankedCargo: 25 });
  drawCargoOffloads([damaged], pilot.ship.position);
  expect(labels.mock.calls.some(([text]) => text === 'CARGO BANKED')).toBe(false);
  labels.mockClear();
  pilot.ship.position = { x: 1000, y: 1000 };
  peer.ship.position = { x: 1000, y: 1000 };
  drawCargoOffloads([pilot, peer], pilot.ship.position);
  expect(labels).not.toHaveBeenCalled();
});
