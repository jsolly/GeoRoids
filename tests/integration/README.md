# Integration Tests for GeoAsteroids

This directory contains integration tests organized by test type and requirements.

## Directory Structure

```text
tests/integration/
├── browser/                     # Browser-based integration tests
│   ├── sanity.test.ts          # End-to-end browser tests
│   ├── screenshots/            # Screenshots from visual regression tests
│   └── README.md               # Browser test documentation
├── server/                      # Server-side integration tests
│   ├── server-parity.test.ts   # WebSocket communication tests
│   ├── server-pause.test.ts    # Server pause/resume tests
│   └── README.md               # Server test documentation
├── entities/                    # Entity-based integration tests
│   ├── roid/                   # Asteroid entity tests
│   │   ├── roidSplitting.test.ts
│   │   └── laserCollisionManager.test.ts
│   ├── local-player/           # Local player entity tests
│   │   ├── localPlayerRoidCollisions.test.ts
│   │   └── ship.test.ts
│   ├── remote-player/          # Remote player entity tests
│   │   └── laserPlayerCollisions.test.ts
│   ├── bot-player/             # Bot player entity tests
│   │   ├── botAsteroidCollisions.test.ts
│   │   └── healthRegeneration.test.ts
│   ├── input/                  # Input handling tests
│   │   ├── keybindings.test.ts
│   │   └── mouse.test.ts
│   └── README.md               # Entity test documentation
├── utils/                       # Shared utility classes and helpers
│   ├── browser-manager.ts      # Browser lifecycle management
│   ├── screenshot-manager.ts   # Screenshot handling and cleanup
│   ├── game-interactions.ts    # Game-specific interactions
│   ├── health-checker.ts       # Server health checking
│   └── test-config.ts          # Test configuration constants
└── README.md                   # This file
```

## Test Categories

### Browser Tests (`/browser/`)

- **End-to-end tests**: Full game functionality tests that run in a real browser
- **Visual regression tests**: Tests that capture screenshots and verify UI behavior
- **User interaction tests**: Tests that simulate real user interactions

### Server Tests (`/server/`)

- **WebSocket communication tests**: Tests server-client message handling
- **Game engine tests**: Tests server-side game logic and state management
- **Server API tests**: Tests server endpoints and responses

### Entity Tests (`/entities/`)

- **Entity-based tests**: Tests organized by game entities (roids, players, bots, input)
- **Mock-based integration tests**: Tests that use mocks for external dependencies
- **Cross-entity interaction tests**: Tests how different entities interact with each other

## Architecture

The tests are organized using a modular utility-based architecture:

- **`BrowserManager`**: Handles browser setup, teardown, and page management
- **`ScreenshotManager`**: Manages screenshot cleanup, naming, and storage
- **`GameInteractions`**: Encapsulates common game interactions and assertions
- **`HealthChecker`**: Verifies server health before running tests
- **`TestConfig`**: Centralizes test configuration and constants

## Prerequisites

1. **Node.js**: Version 24 or higher
2. **Game Server**: The test runner starts a server on the configured ports, which must be unused
3. **Playwright browsers**: Required for browser tests. Install with `npx --no-install playwright install chromium`.

## Setup

1. Install Playwright browsers:

   ```bash
   npx --no-install playwright install chromium
   ```

2. Leave the configured test ports unused. The test runner starts and owns the
   Vite and WebSocket processes for the duration of the run.

When another GeoRoids checkout owns the default ports, choose an unused
isolated pair. The runner passes those URLs to the integration helpers and
refuses to attach to any preexisting service:

```bash
GEOROIDS_TEST_VITE_PORT=5174 GEOROIDS_TEST_SERVER_PORT=3002 \
  ./scripts/test-runner.sh tests/integration/server/
```

## Running Tests

```bash
# Run all integration tests
npm run test:integration

# Run specific test categories
npm run test:integration:browser    # Browser-based tests
npm run test:integration:server     # Server-side tests  
npm run test:integration:entities   # Entity-based tests

# Run specific test files
npm run test:integration -- browser/sanity.test.ts
npm run test:integration -- server/server-parity.test.ts
npm run test:integration -- entities/roid/roidSplitting.test.ts

# Run with UI
npm run test:ui
```

## What the Tests Do

### `Game loads and can fire lasers`

1. Opens a headless Chromium browser
2. Navigates to `http://localhost:5173`
3. Waits for the start screen to load
4. Clicks the play button
5. Waits for the game area to appear
6. Fires 5 times by pressing spacebar
7. Takes a timestamped screenshot
8. Verifies the game is in a playable state

### `Game shows asteroids and bots`

1. Starts the game
2. Takes a timestamped screenshot of the game state
3. Checks for debug info that should show asteroids
4. Verifies the asteroid count is not 0
5. Provides diagnostic information about page content

## Screenshot Management

- **Auto-clear**: Screenshots are automatically cleared before each test run
- **Timestamped**: Each screenshot includes a timestamp for easy identification
- **Organized**: Screenshots are saved in `tests/integration/browser/screenshots/`
- **Naming**: Format: `{test-name}-{timestamp}.png`

## Utility Classes

### BrowserManager

- Manages browser lifecycle (launch, cleanup)
- Handles page creation and cleanup
- Configures browser options and viewport

### ScreenshotManager

- Clears screenshots directory before tests
- Generates timestamped filenames
- Manages screenshot file paths

### GameInteractions

- Encapsulates common game interactions
- Provides helper methods for game state verification
- Handles debug information checking

### TestConfig

- Centralizes test configuration constants
- Defines timeouts, URLs, and selectors
- Makes tests easily configurable

## Output

- **Success**: Creates timestamped screenshots in the screenshots directory
- **Console**: Detailed logging of each step
- **Test Results**: Vitest test runner output

## Integration with Vitest

These tests integrate seamlessly with your existing Vitest setup:

- Use the same test runner and configuration
- Can be run alongside unit tests
- Repository-scoped serialization with one Vitest worker to protect the shared WebSocket server
- Built-in assertions and mocking

## Troubleshooting

- **Connection refused**: Make sure the test runner can start the game server on port 3001
- **Element not found**: Check that the game UI elements have the expected IDs
- **Browser not found**: re-run `npx --no-install playwright install chromium`; if the headless-shell binary is missing, remove the stale lock (`rm -f ~/.cache/ms-playwright/__dirlock`) and reinstall.
- **Test timeouts**: Increase timeout values if the game loads slowly
- **Screenshot issues**: Check that the screenshots directory is writable

## Customization

You can easily extend these tests by:

- Adding new utility classes for specific functionality
- Creating new game interaction methods
- Adding more test scenarios
- Customizing browser configurations
- Testing different browsers (Firefox, WebKit)

## Adding New Tests

To add a new test:

1. Create a new test file or add to `sanity.test.ts`
2. Use the existing utility classes for common operations
3. Follow the established patterns for setup/teardown
4. Use `TestConfig` constants for configuration
