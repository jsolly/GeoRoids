import type { Position } from '../../shared-types';
import { canvasManager } from '../rendering/canvas';
import type { AsteroidToolsState } from './AsteroidToolsController';

/** Passive flight readout. Never captures a click or takes keyboard focus. */
export class FlightFeedback {
  private readonly root: HTMLElement;
  private readonly target: HTMLElement;
  private readonly selectionAnnouncement: HTMLElement;
  private announcedTargetId: string | undefined;
  private readonly motion: HTMLElement;
  private readonly preview: HTMLElement;
  private readonly upgrade: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'flight-feedback';
    this.target = document.createElement('div');
    this.selectionAnnouncement = document.createElement('div');
    this.selectionAnnouncement.id = 'flight-selection-announcement';
    this.selectionAnnouncement.setAttribute('role', 'status');
    this.root.append(this.selectionAnnouncement);
    this.motion = document.createElement('div');
    this.motion.setAttribute('role', 'status');
    this.preview = document.createElement('div');
    this.preview.id = 'flight-preview';
    this.upgrade = document.createElement('div');
    this.upgrade.id = 'flight-upgrade';
    this.root.append(this.target, this.motion, this.preview, this.upgrade);
    container.append(this.root);
  }

  update(state: AsteroidToolsState): void {
    this.root.hidden = !state.pilot || state.pilot.alive === false;
    const target = state.selectedTarget;
    const label =
      target?.phenomenon?.kind === 'reflective'
        ? 'Reflective metal'
        : (target?.material ?? 'Asteroid');
    const position = state.pilot?.position;
    const distance =
      target && position
        ? Math.round(Math.hypot(target.position.x - position.x, target.position.y - position.y))
        : undefined;
    this.write(
      this.target,
      target ? `${label}${distance !== undefined ? ` · ${distance}m` : ''}` : ''
    );
    if (target?.id !== this.announcedTargetId) {
      this.announcedTargetId = target?.id;
      this.selectionAnnouncement.textContent = target
        ? `Target ${state.targets.findIndex((row) => row.id === target.id) + 1} of ${state.targets.length}, ${label}${distance !== undefined ? `, ${distance} meters` : ''}`
        : 'Target cleared';
    }
    this.write(this.motion, state.pilot?.kitId === 'hauler' ? state.status : '');
    const preview = state.reflectionPreview;
    const endings = {
      distance: 'Range limit',
      'bounce-limit': 'Max bounces',
      blocked: 'Blocked',
      stationary: 'No path',
    };
    this.write(
      this.preview,
      preview
        ? `${preview.impacts.length} impact${preview.impacts.length === 1 ? '' : 's'} · ${Math.round(preview.traveledDistance)}m · ${endings[preview.termination]}`
        : ''
    );
    const upgrade = state.pilot?.laserUpgrade;
    this.write(
      this.upgrade,
      upgrade && upgrade.charges > 0 && upgrade.expiresAt > Date.now()
        ? `Laser core · ${upgrade.charges} charges · ${Math.ceil((upgrade.expiresAt - Date.now()) / 1000)}s`
        : ''
    );
  }

  draw(state: AsteroidToolsState, shipPosition: Position): void {
    const ctx = canvasManager.getContext();
    if (!ctx || !state.pilot || state.pilot.alive === false || !state.selectedTarget) {
      return;
    }
    const point = canvasManager.worldToScreen(state.selectedTarget.position, shipPosition);
    ctx.save();
    ctx.strokeStyle = '#5eead4';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(
      point.x,
      point.y,
      state.selectedTarget.size * canvasManager.getPlayfieldScale() + 8,
      0,
      Math.PI * 2
    );
    ctx.stroke();
    ctx.globalAlpha = 0.4;
    for (const segment of state.reflectionPreview?.segments ?? []) {
      const start = canvasManager.worldToScreen(segment.start, shipPosition);
      const end = canvasManager.worldToScreen(segment.end, shipPosition);
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  dispose(): void {
    this.root.remove();
  }

  private write(element: HTMLElement, value: string): void {
    if (element.textContent !== value) {
      element.textContent = value;
    }
    element.hidden = value === '';
  }
}
