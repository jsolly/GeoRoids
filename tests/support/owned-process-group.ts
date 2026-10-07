import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import process from 'node:process';

/** Verify the whole detached group, including children after its leader exits. */
export function ownedGroupAbsentInInventory(inventory: string, pgid: number): boolean {
  assert(Number.isSafeInteger(pgid) && pgid > 0, 'Invalid owned process group');
  const rows = inventory
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  assert(rows.length > 0, 'Process inventory is empty');
  const pids = new Set<number>();
  let present = false;
  for (const row of rows) {
    const match = /^(\d+)\s+(\d+)$/u.exec(row);
    assert(match, 'Process inventory has an unreadable row');
    const pid = Number(match[1]);
    const group = Number(match[2]);
    assert(Number.isSafeInteger(pid) && Number.isSafeInteger(group), 'Invalid inventory PID');
    assert(!pids.has(pid), 'Process inventory repeats a PID');
    pids.add(pid);
    present ||= group === pgid;
  }
  return !present;
}

type GroupObservation =
  | { kind: 'signal-error'; error: unknown }
  | { kind: 'inventory'; absent: boolean };

/** EPERM can describe a retiring Darwin group containing only zombies. */
export async function ownedProcessGroupAbsent(
  pgid: number,
  record?: (observation: GroupObservation) => void
): Promise<boolean> {
  assert(Number.isSafeInteger(pgid) && pgid > 0, 'Invalid owned process group');
  let signalFailure: unknown;
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    signalFailure = error;
  }
  if (signalFailure instanceof Error && 'code' in signalFailure && signalFailure.code === 'ESRCH') {
    return true;
  }
  record?.({ kind: 'signal-error', error: signalFailure });
  if (
    !(signalFailure instanceof Error && 'code' in signalFailure && signalFailure.code === 'EPERM')
  ) {
    throw signalFailure;
  }
  // Permission denial alone never proves absence. Count every inventory member,
  // including zombies and descendants whose group leader has already exited.
  let inventoryFailure: unknown;
  try {
    const inventory = await new Promise<string>((resolve, reject) => {
      execFile(
        '/bin/ps',
        ['-axo', 'pid=,pgid='],
        { timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (failure, stdout) => (failure ? reject(failure) : resolve(stdout))
      );
    });
    const absent = ownedGroupAbsentInInventory(inventory, pgid);
    record?.({ kind: 'inventory', absent });
    return absent;
  } catch (error) {
    inventoryFailure = error;
  }
  throw new AggregateError(
    [signalFailure, inventoryFailure],
    'Owned browser process group could not be verified'
  );
}
