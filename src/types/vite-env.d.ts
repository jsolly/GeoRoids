/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEBSOCKET_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Extend the global Window interface for game controller access
interface Window {
  gameController?: import('../core/gameController').GameController;
}
