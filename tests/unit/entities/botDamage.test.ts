import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DAMAGE } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';

describe('Bot Damage System', () => {
  let botShip: Ship;

  beforeEach(() => {
    // Create a bot ship
    botShip = new Ship({
      isBot: true,
      position: { x: 100, y: 100 },
      color: '#ff8800',
    });
    botShip.health = 100;
    botShip.maxHealth = 100;
  });

  it('should apply damage to bot ship when takeDamage is called', () => {
    const initialHealth = botShip.health;
    const damage = DAMAGE.LASER_HIT;

    botShip.takeDamage(damage, 'laser', 'test-player');

    expect(botShip.health).toBe(initialHealth - damage);
  });

  it('should explode bot when health reaches zero', () => {
    const damage = botShip.health; // Damage equal to current health
    const explodeSpy = vi.spyOn(botShip, 'explode');

    botShip.takeDamage(damage, 'laser', 'test-player');

    expect(botShip.health).toBe(0);
    expect(botShip.exploding).toBe(true);
    expect(explodeSpy).toHaveBeenCalledWith('laser', 'test-player');
  });

  it('should not take damage when exploding', () => {
    botShip.exploding = true;
    const initialHealth = botShip.health;
    const damage = DAMAGE.LASER_HIT;

    botShip.takeDamage(damage, 'laser', 'test-player');

    expect(botShip.health).toBe(initialHealth); // Health should not change
  });

  it('should handle multiple damage instances', () => {
    const damage1 = 25;
    const damage2 = 30;
    const initialHealth = botShip.health;

    botShip.takeDamage(damage1, 'laser', 'test-player');
    expect(botShip.health).toBe(initialHealth - damage1);

    botShip.takeDamage(damage2, 'laser', 'test-player');
    expect(botShip.health).toBe(initialHealth - damage1 - damage2);
  });

  it('should not reduce health below zero', () => {
    const excessiveDamage = 200;
    // const initialHealth = botShip.health;

    botShip.takeDamage(excessiveDamage, 'laser', 'test-player');

    expect(botShip.health).toBe(0);
    expect(botShip.exploding).toBe(true);
  });
});
