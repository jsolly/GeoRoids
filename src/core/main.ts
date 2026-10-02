import { clientPerformance } from '../diagnostics/performanceMetrics';
import { canvasManager } from '../rendering/canvasSurface';
import '../ui/mainMenu';
import { paintDebugHud } from '../ui/debugHud';
import { initNetworkStatusUI } from '../ui/networkStatus';
import { initializeSchematicEquipHint } from '../ui/schematicEquipHint';
import { installGlobalErrorLogging } from '../utils/globalErrorLogging';
import { EventLoop } from './eventLoop';
import { GameController } from './gameController';

installGlobalErrorLogging();
initializeSchematicEquipHint();
initNetworkStatusUI();

const initializeCanvas = (): void => canvasManager.initialize();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeCanvas, { once: true });
} else {
  initializeCanvas();
}

const eventLoop = new EventLoop(GameController.getInstance(), {
  window,
  document,
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
  now: () => performance.now(),
  paintDebugHud,
  observeRenderer: () => clientPerformance.recordRendererFrame(canvasManager.getRendererBackend()),
});

import.meta.hot?.dispose(() => {
  document.removeEventListener('DOMContentLoaded', initializeCanvas);
  eventLoop.dispose();
});
