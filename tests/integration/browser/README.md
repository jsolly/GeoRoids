# Browser Integration Tests

This directory contains integration tests that require a real browser environment to run.

## Test Types

- **End-to-end tests**: Full game functionality tests that run in a browser
- **Visual regression tests**: Tests that capture screenshots and verify UI behavior
- **User interaction tests**: Tests that simulate real user interactions (clicks, keyboard, etc.)

## Requirements

These tests require:

- Unused configured test ports; `scripts/test-runner.sh` starts and owns the Vite and WebSocket services
- A browser environment (Playwright/Puppeteer)

## Running Tests

```bash
# Run all browser integration tests
npm run test:integration:browser

# Run specific browser test
npm run test:integration:browser -- sanity/sanity.test.ts
```

## Test Organization

Tests are organized into logical folders:

### `/collision/`

- **botAsteroidCollisions.test.ts** - Bot collision with asteroids
- **laserCollisions.test.ts** - Laser collision with asteroids

### `/laser/`

- **laserCommunication.test.ts** - Laser firing and network communication
- **laserNetworkFlow.test.ts** - Complete network flow for laser events
- **laserServerLogs.test.ts** - Server-side logging for laser events

### `/roid/`

- **roidSplitting.test.ts** - Roid splitting behavior on collision

### `/sanity/`

- **sanity.test.ts** - Core game functionality and visual regression tests

## Screenshots

The `screenshots/` directory contains captured screenshots from visual regression tests.
