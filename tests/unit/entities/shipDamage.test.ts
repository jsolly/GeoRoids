import { beforeEach, describe, expect, test } from 'vitest';
import { SHIP } from '../../../src/constants';
import { Ship } from '../../../src/entities/ship/Ship';

describe('Ship Damage System', () => {
  let ship: Ship;

  beforeEach(() => {
    ship = new Ship({
      position: { x: 100, y: 100 },
    });
    ship.health = SHIP.MAX_HEALTH;
    ship.maxHealth = SHIP.MAX_HEALTH;
    ship.exploding = false; // Ensure not exploding for tests
  });

  describe('takeDamage', () => {
    test('reduces health by damage amount', () => {
      const initialHealth = ship.health;
      const damage = 25;

      ship.takeDamage(damage);

      expect(ship.health).toBe(initialHealth - damage);
    });

    test('can handle multiple damage instances', () => {
      ship.takeDamage(25);
      expect(ship.health).toBe(75);

      ship.takeDamage(30);
      expect(ship.health).toBe(45);
    });

    test('cannot reduce health below zero', () => {
      const damage = 150; // More than max health

      ship.takeDamage(damage);

      expect(ship.health).toBe(0);
    });

    test('sets exploding to true when health reaches zero', () => {
      const damage = 100; // Exactly max health

      ship.takeDamage(damage);

      expect(ship.health).toBe(0);
      expect(ship.exploding).toBe(true);
    });

    test('does not set exploding when health is above zero', () => {
      const damage = 50;

      ship.takeDamage(damage);

      expect(ship.health).toBe(50);
      expect(ship.exploding).toBe(false);
    });

    test('handles zero damage', () => {
      const initialHealth = ship.health;

      ship.takeDamage(0);

      expect(ship.health).toBe(initialHealth);
      expect(ship.exploding).toBe(false);
    });

    test('handles negative damage (healing)', () => {
      ship.takeDamage(50); // Take some damage first
      expect(ship.health).toBe(50);

      ship.takeDamage(-25); // Negative damage = healing

      expect(ship.health).toBe(75);
    });

    test('cannot exceed max health when healing', () => {
      ship.takeDamage(-50); // Try to heal beyond max

      expect(ship.health).toBe(100); // Should cap at max health
    });
  });

  describe('health properties', () => {
    test('has correct initial health values', () => {
      expect(ship.health).toBe(100);
      expect(ship.maxHealth).toBe(100);
    });

    test('health is always between 0 and maxHealth', () => {
      ship.takeDamage(200); // Try to damage beyond zero
      expect(ship.health).toBe(0);
      expect(ship.health).toBeGreaterThanOrEqual(0);

      // Reset ship health and exploding state for healing test
      ship.health = 50; // Set to a damaged state
      ship.exploding = false; // Reset exploding state so healing can work
      ship.takeDamage(-200); // Try to heal beyond max (50 - (-200) = 250, clamped to 100)
      expect(ship.health).toBe(100); // Should cap at max health
      expect(ship.health).toBeLessThanOrEqual(ship.maxHealth);
    });
  });
});
