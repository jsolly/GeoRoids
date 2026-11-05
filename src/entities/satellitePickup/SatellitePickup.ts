import type {
  Position,
  SatellitePickupData,
  SatellitePickupState,
  SatellitePickupTypeId,
} from '../../../shared-types';
import { playDestructionSound } from '../../audio/destructionSounds';
import { playFeedback } from '../../audio/feedbackSounds';
import { playLocalHaptic } from '../../fx/haptics';
import { PlayerManager } from '../player/PlayerManager';

export class SatellitePickup {
  id: string;
  name: string;
  typeId: SatellitePickupTypeId;
  position: Position;
  angle: number;
  radius: number;
  color: string;
  state: SatellitePickupState;
  ownerId: string | null;
  health: number;
  maxHealth: number;

  constructor(data: SatellitePickupData) {
    this.id = data.id;
    this.name = data.name;
    this.typeId = data.typeId;
    this.position = { ...data.position };
    this.angle = data.angle;
    this.radius = data.radius;
    this.color = data.color;
    this.state = data.state;
    this.ownerId = data.ownerId;
    this.health = data.health;
    this.maxHealth = data.maxHealth;
  }

  updateFromServer(data: SatellitePickupData): void {
    if (this.state === 'stored' && data.state === 'orbiting') {
      playFeedback('satelliteEquip', data.position);
      playLocalHaptic(data.ownerId === PlayerManager.getInstance().getLocalPlayer()?.id, 'pickup');
    }
    if (data.state === 'broken' && this.state !== 'broken') {
      playDestructionSound('satellite', data.position);
    }
    this.name = data.name;
    this.typeId = data.typeId;
    this.position = { ...data.position };
    this.angle = data.angle;
    this.radius = data.radius;
    this.color = data.color;
    this.state = data.state;
    this.ownerId = data.ownerId;
    this.health = data.health;
    this.maxHealth = data.maxHealth;
  }
}
