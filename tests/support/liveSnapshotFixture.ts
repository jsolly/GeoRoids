import { offerAtlas } from '../../shared/atlasTransport';
import { ExplorationMap } from '../../shared/exploration';
import { SnapshotEncoder } from '../../shared/snapshotProtocol';

type State = ConstructorParameters<typeof SnapshotEncoder>[0];
type Baseline = Parameters<SnapshotEncoder['encode']>[1];

function live(state: State): State {
  if ('exploration' in state) {
    const { exploration: _atlas, ...world } = state;
    return world;
  }
  return state;
}

/** Complete small chart fixture at the producer boundary. Large/recovery stories
 * use the real streaming broadcaster instead of silently truncating this view. */
export class LiveSnapshotFixture extends SnapshotEncoder {
  private readonly map = new ExplorationMap();

  constructor(state: State) {
    super(live(state), undefined, 'live');
    if ('exploration' in state) {
      this.map.restore(state.exploration.map((tile) => ({ ...tile })));
    }
  }

  override encode(sequence: number, baseline?: Baseline) {
    const frame = super.encode(
      sequence,
      baseline ? { ...baseline, state: live(baseline.state) } : undefined
    );
    return { ...frame, atlas: this.fixtureOffer().segment };
  }

  override encodeSerialized(sequence: number, baseline: Baseline, timestamp: number) {
    return super.encodeSerialized(
      sequence,
      baseline ? { ...baseline, state: live(baseline.state) } : undefined,
      timestamp,
      this.fixtureOffer()
    );
  }

  private fixtureOffer() {
    const atlas = offerAtlas(this.map, { kind: 'start' }, 1);
    if (!atlas || atlas.segment.through === null) {
      throw new Error('Fixture atlas needs the real streaming harness');
    }
    return atlas;
  }
}
