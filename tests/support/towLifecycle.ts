export type TowSample = {
  pilotId: string;
  epoch: number | undefined;
  targetId: string | null;
  health: number;
  exploding: boolean;
  inTransit: boolean;
  at: number;
};

/** Two durable observations, rather than a poll that must catch a short latch. */
export class TowLifecycle {
  private attached: TowSample | null = null;
  private released: TowSample | null = null;
  private failure: string | null = null;

  constructor(private readonly selection: { pilotId: string; targetId: string; epoch: number }) {}

  observe(sample: TowSample, cableDrawn = false): void {
    if (this.failure !== null) {
      return;
    }
    if (
      sample.pilotId !== this.selection.pilotId ||
      sample.epoch !== this.selection.epoch ||
      sample.health <= 0 ||
      sample.exploding ||
      sample.inTransit
    ) {
      this.failure = 'Selected live pilot or fixture epoch changed';
      return;
    }
    if (sample.targetId !== null && sample.targetId !== this.selection.targetId) {
      this.failure = 'Cable attached to a different target';
      return;
    }
    if (this.released !== null && sample.targetId !== null) {
      this.failure = 'Cable reattached after the recorded release';
      return;
    }
    if (this.attached === null && cableDrawn && sample.targetId === this.selection.targetId) {
      this.attached = { ...sample };
    } else if (this.attached !== null && this.released === null && sample.targetId === null) {
      if (sample.at <= this.attached.at) {
        this.failure = 'Release did not follow the rendered attachment';
        return;
      }
      this.released = { ...sample };
    }
  }

  snapshot(): {
    attached: TowSample | null;
    released: TowSample | null;
    failure: string | null;
  } {
    return structuredClone({
      attached: this.attached,
      released: this.released,
      failure: this.failure,
    });
  }

  finish(): ReturnType<TowLifecycle['snapshot']> {
    if (this.failure !== null) {
      throw new Error(this.failure);
    }
    if (this.attached === null || this.released === null) {
      throw new Error('Rendered tow attachment and release were not both observed');
    }
    return this.snapshot();
  }
}
