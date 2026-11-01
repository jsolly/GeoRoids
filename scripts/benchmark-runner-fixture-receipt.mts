import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';

// Keep all twelve positional slots of the existing fixture receipt protocol.
const [, , destination, mode, worktree, pid, , code, cleaned, timedOut, held, session] =
  process.argv.slice(2);
assert(destination !== undefined, 'Missing fixture receipt destination');

interface FixtureReceipt {
  kind: 'georoids-runner-final';
  mode: string | undefined;
  worktree: string | undefined;
  ownerPid: number;
  exitCode: number;
  cleanupSucceeded: boolean;
  lockReleased: boolean;
  sessionRemoved: boolean;
  timedOut: boolean;
}

const receipt: FixtureReceipt = {
  kind: 'georoids-runner-final',
  mode,
  worktree,
  ownerPid: Number(pid),
  exitCode: Number(code),
  cleanupSucceeded: cleaned === 'true',
  lockReleased: held === 'false',
  sessionRemoved: !session || !existsSync(session),
  timedOut: timedOut === 'true',
};
writeFileSync(destination, JSON.stringify(receipt));
