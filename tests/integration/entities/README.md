# Integration Tests - Entity-Based Structure

This directory contains integration tests organized by entity types. This structure reflects the game's architecture where core functionality revolves around different entity interactions.

## Directory Structure

### `/roid/`

Tests related to asteroid (roid) entities and their interactions:

- **roidSplitting.test.ts** - Tests asteroid splitting mechanics when destroyed
- **laserCollisionManager.test.ts** - Tests laser collision detection with asteroids

### `/local-player/`

Tests for the local player entity and its interactions:

- **localPlayerRoidCollisions.test.ts** - Tests local player collision with asteroids
- **ship.test.ts** - Tests basic ship functionality and movement

### `/remote-player/`

Tests for remote player entities and multiplayer interactions:

- **laserPlayerCollisions.test.ts** - Tests laser damage between players

### `/bot-player/`

Tests for bot player entities and their behavior:

- **botAsteroidCollisions.test.ts** - Tests bot collision with asteroids and damage handling
- **healthRegeneration.test.ts** - Tests health regeneration mechanics for all player types

### `/input/`

Tests for input handling systems:

- **keybindings.test.ts** - Tests keyboard input handling
- **mouse.test.ts** - Tests mouse input handling

## Benefits of Entity-Based Organization

1. **Clearer Test Organization**: Tests are grouped by what they're testing rather than how they're implemented
2. **Better Test Discovery**: Easy to find tests related to specific game entities
3. **Reflects Game Architecture**: Matches the actual game structure where entities are the primary concern
4. **Easier Maintenance**: When working on a specific entity, all related tests are in one place

## Running Tests

To run all entity integration tests:

```bash
./scripts/test-runner.sh tests/integration/entities/
```

To run tests for a specific entity:

```bash
./scripts/test-runner.sh tests/integration/entities/roid/
./scripts/test-runner.sh tests/integration/entities/local-player/
./scripts/test-runner.sh tests/integration/entities/remote-player/
./scripts/test-runner.sh tests/integration/entities/bot-player/
./scripts/test-runner.sh tests/integration/entities/input/
```
