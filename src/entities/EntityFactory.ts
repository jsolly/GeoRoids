import { v4 as uuidv4 } from 'uuid';
import type { Position, ShipKitId, SoftFactionId, Velocity } from '../../shared-types';
import { PALETTE } from '../constants';
import { MockPlayerInput } from '../input/MockPlayerInput';
import { getFactionColor } from '../utils/colorUtils';
import { getRandomPositionInAsteroidField, resolveSpawnPosition } from '../utils/spawnPosition';
import { Laser } from './laser/Laser';
import { Player } from './player/Player';
import { Roid, RoidBelt } from './roid/Roid';

export interface PlayerConfig {
  id?: string;
  name: string;
  type: 'local' | 'remote' | 'bot';
  position?: Position;
  color?: string;
  shotCooldown?: number;
  kitId?: ShipKitId;
  factionId?: SoftFactionId;
}

export interface RoidConfig {
  position?: Position;
  size?: number;
  id?: string;
}

/**
 * Unified factory for players (local, remote, bot) and world entities.
 * Bots are the same Player type as humans; the server owns spawn/AI.
 */
export class EntityFactory {
  private static instance: EntityFactory;

  private constructor() {}

  static getInstance(): EntityFactory {
    if (!EntityFactory.instance) {
      EntityFactory.instance = new EntityFactory();
    }
    return EntityFactory.instance;
  }

  // Player creation methods
  createPlayer(config: PlayerConfig): Player {
    const player = this.instantiatePlayer(config);
    this.applyPlayerConfiguration(player, config);
    this.applyTypeSpecificConfiguration(player, config);
    return player;
  }

  createLocalPlayer(name: string, position?: Position, kitId?: ShipKitId): Player {
    return this.createPlayer({
      name,
      type: 'local',
      ...(position !== undefined ? { position: position } : {}),
      ...(kitId !== undefined ? { kitId: kitId } : {}),
    });
  }

  createRemotePlayer(id: string, name: string, position: Position, color?: string): Player {
    return this.createPlayer({
      id,
      name,
      type: 'remote',
      position,
      ...(color !== undefined ? { color: color } : {}),
    });
  }

  createBotPlayer(name: string, position?: Position): Player {
    return this.createPlayer({
      name,
      type: 'bot',
      ...(position !== undefined ? { position: position } : {}),
    });
  }

  // Roid creation methods
  createRoid(config: RoidConfig = {}): Roid {
    const position = config.position || this.generateRandomRoidPosition();
    const size = config.size || 15; // Default medium size
    return new Roid(position, size, config.id);
  }

  createEmptyRoidBelt(): RoidBelt {
    return new RoidBelt(false);
  }

  // Laser creation method
  createLaser(config: {
    position: Position;
    velocity: Velocity;
    distTraveled: number;
    explodeTime: number;
    hasExploded: boolean;
  }): Laser {
    return new Laser(
      config.position,
      config.velocity,
      config.distTraveled,
      config.explodeTime,
      config.hasExploded
    );
  }

  // Private helper methods
  private instantiatePlayer(config: PlayerConfig): Player {
    const id = config.id || uuidv4();
    return new Player({
      id,
      name: config.name,
      type: config.type,
      input: new MockPlayerInput(),
      ...(config.kitId !== undefined ? { kitId: config.kitId } : {}),
      ...(config.factionId !== undefined ? { factionId: config.factionId } : {}),
    });
  }

  private applyPlayerConfiguration(player: Player, config: PlayerConfig): void {
    player.ship.position = resolveSpawnPosition(config.position);

    // Apply customizations
    if (config.color) {
      player.color = config.color;
      player.ship.color = config.color;
    }

    if (config.shotCooldown !== undefined) {
      player.ship.shotCooldown = config.shotCooldown;
    }
  }

  private applyTypeSpecificConfiguration(player: Player, config: PlayerConfig): void {
    switch (config.type) {
      case 'bot':
        this.applyBotConfiguration(player, config);
        break;
      case 'remote':
        this.applyRemoteConfiguration(player, config);
        break;
      case 'local':
        // Local players use default configuration
        break;
    }
  }

  private applyBotConfiguration(player: Player, config: PlayerConfig): void {
    // Apply bot-specific defaults if not specified
    if (!config.color) {
      player.color = PALETTE.BOT;
      player.ship.color = player.color;
    }

    if (config.shotCooldown === undefined) {
      player.ship.shotCooldown = 500 + Math.random() * 500; // 0.5-1.0 seconds
    }
  }

  private applyRemoteConfiguration(player: Player, config: PlayerConfig): void {
    // Remote players use the color provided by the server
    if (config.color) {
      player.color = config.color;
      player.ship.color = config.color;
    } else {
      // Fallback to random color if no color provided (shouldn't happen with proper server sync)
      player.color = getFactionColor('remote');
      player.ship.color = player.color;
    }
  }

  private generateRandomRoidPosition(): Position {
    return getRandomPositionInAsteroidField();
  }
}

// Export singleton instance for backward compatibility
export const entityFactory = EntityFactory.getInstance();
