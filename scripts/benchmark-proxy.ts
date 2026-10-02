import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { networkProfiles } from '../benchmarks/network-profiles';
import { startProxyControl } from '../benchmarks/proxy-control';
import { startTcpProxy } from '../benchmarks/tcp-proxy';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    port: { type: 'string' },
    network: { type: 'string' },
    seed: { type: 'string' },
    ready: { type: 'string' },
    stats: { type: 'string' },
    control: { type: 'string' },
  },
});
assert(values.ready && values.stats && values.control, 'Missing owned-session paths');
const network = values.network;
assert(
  network === 'clean' || network === 'normal' || network === 'degraded',
  'Unknown proxy profile'
);
const targetPort = Number(values.target);
const port = values.port === undefined ? 0 : Number(values.port);
const seed = Number(values.seed);
assert(Number.isSafeInteger(targetPort) && targetPort > 0 && targetPort <= 65535, 'Invalid target');
assert(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'Invalid proxy listen port');
assert(port === 0 || port !== targetPort, 'Proxy listen port must differ from target');
assert(Number.isSafeInteger(seed) && seed > 0, 'Invalid seed');
const proxy = await startTcpProxy(
  network === 'clean'
    ? { targetPort, port, seed, transparent: true }
    : { targetPort, port, seed, ...networkProfiles[network] }
);
let closeControl: () => Promise<void>;
try {
  closeControl = await startProxyControl(values.control, network, proxy.read);
} catch (error) {
  await proxy.close();
  throw error;
}
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
    const results = await Promise.allSettled([closeControl(), proxy.close()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        process.stderr.write(`${String(result.reason)}\n`);
        process.exitCode = 1;
      }
    }
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
try {
  await save();
  // Ready means both the gameplay path and its private live probe are available.
  await writeFile(values.ready, String(proxy.port));
} catch (error) {
  await stop(error);
  throw error;
}
