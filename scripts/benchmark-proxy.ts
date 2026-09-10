import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { networkProfiles } from '../benchmarks/network-profiles';
import { startTcpProxy } from '../benchmarks/tcp-proxy';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    network: { type: 'string' },
    seed: { type: 'string' },
    ready: { type: 'string' },
    stats: { type: 'string' },
  },
});
assert(values.ready && values.stats, 'Missing owned-session paths');
const network = values.network;
assert(network === 'normal' || network === 'degraded', 'Proxy requires an impaired profile');
const targetPort = Number(values.target);
const seed = Number(values.seed);
assert(Number.isSafeInteger(targetPort) && targetPort > 0 && targetPort <= 65535, 'Invalid target');
assert(Number.isSafeInteger(seed) && seed > 0, 'Invalid seed');
const proxy = await startTcpProxy({ targetPort, seed, ...networkProfiles[network] });
let stopping = false;
const statsPath = values.stats;
let writing = Promise.resolve();
function save() {
  writing = writing.then(() => writeFile(statsPath, JSON.stringify(proxy.read())));
  return writing;
}
const timer = setInterval(() => {
  void save().catch(stop);
}, 1000);
async function stop(error?: unknown) {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(timer);
  try {
    await proxy.close();
    await save();
  } catch (failure) {
    process.stderr.write(`${String(failure)}\n`);
    process.exitCode = 1;
  }
  if (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
await save();
await writeFile(values.ready, String(proxy.port));
