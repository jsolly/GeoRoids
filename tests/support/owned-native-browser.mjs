import { spawn } from 'node:child_process';
import process from 'node:process';

const [executable, ...args] = process.argv.slice(2);
if (!executable || !process.connected) {
  throw new Error('Native browser requires an executable and an owning IPC connection');
}

// Chromium shares this detached launcher's group. Its owner can close the group,
// and loss of the IPC owner also retires it, including children that ignore TERM.
const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'] });
let retiring = false;
function retire() {
  if (retiring) {
    return;
  }
  retiring = true;
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 500);
  process.kill(-process.pid, 'SIGTERM');
}
process.on('disconnect', retire);
process.on('SIGTERM', retire);
browser.on('error', (error) => {
  console.error(error.message);
  retire();
});
browser.on('exit', (code, signal) => {
  if (!retiring) {
    if (code !== 0) {
      console.error(`Owned Chromium exited ${code}/${signal}`);
    }
    // A crashed browser leader can leave GPU/renderer descendants alive. Keep
    // the launcher until its final group signal, even after a normal close.
    retire();
  }
});
