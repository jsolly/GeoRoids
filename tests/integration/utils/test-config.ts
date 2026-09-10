const testVitePort = process.env['GEOROIDS_TEST_VITE_PORT'] ?? '5173';
const testServerPort = process.env['GEOROIDS_TEST_SERVER_PORT'] ?? '3001';

export const TestConfig = {
  // URLs
  GAME_URL: `http://localhost:${testVitePort}`,
  SERVER_URL: `http://localhost:${testServerPort}`,

  // Timeouts
  DEFAULT_TIMEOUT: 60000,
  GAME_INIT_TIMEOUT: 5000,
} as const;

export const TestSelectors = {
  GAME_CANVAS: '#gameCanvas',
} as const;
