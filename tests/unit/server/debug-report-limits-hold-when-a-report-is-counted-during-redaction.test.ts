// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DebugReportStore } from '../../../server/debugReports/store';
import type { DebugReportSubmission } from '../../../shared-types';

// Redaction runs between the early limit check and the counting transaction.
// Hooking it lets the same store count another report in exactly that gap,
// which needs no second connection to the database.
const gap = vi.hoisted(() => ({ during: null as (() => void) | null }));
vi.mock('../../../shared/debugReports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/debugReports')>();
  return {
    ...actual,
    sanitizeDebugDiagnostics: (...args: Parameters<typeof actual.sanitizeDebugDiagnostics>) => {
      const during = gap.during;
      gap.during = null;
      during?.();
      return actual.sanitizeDebugDiagnostics(...args);
    },
  };
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  gap.during = null;
  for (const release of cleanup.splice(0).reverse()) {
    release();
  }
});

function submission(): DebugReportSubmission {
  return {
    version: 1,
    id: randomUUID(),
    receiptToken: randomBytes(32).toString('hex'),
    description: 'Ship controls stopped responding.',
    submittedAt: '2026-10-15T12:00:00.000Z',
    diagnostics: {
      state: { version: 1, capturedAt: '2026-10-15T12:00:00.000Z', sessionId: 'session-1' },
      recentLogs: [],
    },
  };
}

test('a report counted while another is being redacted is still refused at the limit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'georoids-debug-limits-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new DebugReportStore({
    path: join(directory, 'reports.sqlite'),
    token: 'server-credential',
    projectId: 'project-one',
    sectionId: 'section-one',
  });
  cleanup.push(() => store.close());
  const now = 1_800_000_000_000;
  store.accept(submission(), 'pilot', {}, now);
  store.accept(submission(), 'pilot', {}, now);
  gap.during = () => {
    expect(store.accept(submission(), 'pilot', {}, now).state).toBe('pending');
  };
  // Two of three were counted when this upload passed its early check; the third
  // was counted during its redaction, so only the transaction can see the limit.
  expect(() => store.accept(submission(), 'pilot', {}, now)).toThrow('limit reached');
  expect(gap.during).toBeNull();
  expect(store.diagnostics().pending).toBe(3);
});
