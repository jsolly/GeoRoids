# Server Integration Tests

This directory contains integration tests that test server-side functionality directly.

## Test Types

- **WebSocket communication tests**: Tests server-client message handling
- **Game engine tests**: Tests server-side game logic and state management
- **Server API tests**: Tests server endpoints and responses

## Requirements

These tests run through `scripts/test-runner.sh`, which starts and owns the local WebSocket/Vite services when the configured ports are unused. The runner refuses to attach to preexisting services. They require Node.js, but no browser.

## Running Tests

```bash
# Run all server integration tests
npm run test:integration:server

# Run specific server test
npm run test:integration:server -- server-parity.test.ts
```

## Test Files

- `server-parity.test.ts` - WebSocket message handling and server-client communication
- `server-pause.test.ts` - Server pause/resume functionality
