const testVitePort = process.env['GEOROIDS_TEST_VITE_PORT'] ?? '5173';
const testServerPort = process.env['GEOROIDS_TEST_SERVER_PORT'] ?? '3001';

export const TestConfig = {
  // URLs
  GAME_URL: `http://localhost:${testVitePort}`,
  SERVER_URL: `http://localhost:${testServerPort}`,

  // Timeouts
  DEFAULT_TIMEOUT: 60000,
  ELEMENT_WAIT_TIMEOUT: 5000,
  GAME_INIT_TIMEOUT: 5000,
  LASER_DELAY: 500,

  // Viewport
  VIEWPORT_WIDTH: 1920,
  VIEWPORT_HEIGHT: 1080,

  // Test data
  DEFAULT_LASER_COUNT: 5,
  SCREENSHOT_DIR: 'screenshots',

  // Browser arguments
  BROWSER_ARGS: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-features=VizDisplayCompositor',
  ],

  // User agent
  USER_AGENT: 'GeoAsteroids-Test-Bot/1.0',
} as const;

export const TestSelectors = {
  START_SCREEN: '#start-screen',
  START_GAME_BUTTON: '#start-game',
  GAME_AREA: '#gameArea',
  GAME_CANVAS: '#gameCanvas',
  DEBUG_INFO: 'text=Asteroids:',
  DEBUG_MODE: 'text=DEBUG MODE',
} as const;
