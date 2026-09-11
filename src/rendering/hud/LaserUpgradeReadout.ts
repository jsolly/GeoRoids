import type { LaserUpgrade } from '../../../shared-types';

/** Passive core charge counter; flight controls remain on the playfield. */
export class LaserUpgradeReadout {
  private readonly root: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'flight-upgrade';
    this.root.hidden = true;
    container.append(this.root);
  }

  update(upgrade: LaserUpgrade | undefined): void {
    const remaining = upgrade ? Math.ceil((upgrade.expiresAt - Date.now()) / 1000) : 0;
    const text =
      upgrade && upgrade.charges > 0 && remaining > 0
        ? `Laser core · ${upgrade.charges} charges · ${remaining}s`
        : '';
    if (this.root.textContent !== text) {
      this.root.textContent = text;
    }
    this.root.hidden = text === '';
  }
}
