import { flushSync, mount, tick, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { afterEach, expect, test, vi } from 'vitest';
import type { DebugDiagnosticSnapshot } from '../../../shared-types';
import DebugReportForm from '../../../src/components/game/DebugReportForm.svelte';
import {
  createDebugReportClient,
  type DebugReportClientView,
} from '../../../src/diagnostics/debugReportClient';

let form: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (form) {
    await unmount(form);
  }
  form = undefined;
  document.body.replaceChildren();
});

test('typing a report and sending crosses browser storage before HTTP and exposes recovery on failure', async () => {
  const request = vi.fn<typeof fetch>();
  const storage = {
    read() {
      return Promise.resolve(null);
    },
    write() {
      return Promise.reject(new Error('storage quota'));
    },
  };
  const snapshot: DebugDiagnosticSnapshot = {
    state: {
      version: 1,
      capturedAt: '2026-10-15T12:00:00.000Z',
      sessionId: 'session',
      input: { liveTouches: 0 },
    },
    recentLogs: [],
  };
  let sending: Promise<void> | undefined;
  let submittedDiagnostics: DebugDiagnosticSnapshot | undefined;
  const views = writable<DebugReportClientView>({
    state: 'idle',
    message: '',
    submission: null,
    reportId: null,
    canSend: false,
  });
  const view = fromStore(views);
  const client = createDebugReportClient((next) => views.set(next), { storage, fetch: request });
  await client.restore();
  form = mount(DebugReportForm, {
    target: document.body,
    props: {
      snapshot,
      get view() {
        return view.current;
      },
      onsend(description: string, diagnostics: DebugDiagnosticSnapshot) {
        submittedDiagnostics = diagnostics;
        sending = client.send(description, diagnostics);
      },
      onretry: () => {},
      onnew: async () => false,
      onclose: () => {},
    },
  });
  flushSync();
  const field = document.querySelector('textarea');
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error('missing report field');
  }
  field.value = 'Ship stopped moving';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(
    [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Send')
      ?.disabled
  ).toBe(false);
  document
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await sending;
  await tick();
  expect(request).not.toHaveBeenCalled();
  expect(submittedDiagnostics?.state).toMatchObject({
    capturedAt: '2026-10-15T12:00:00.000Z',
    input: {
      liveTouches: 0,
      reportForm: { counts: { input: 1 }, field: { valueLength: 19 } },
    },
  });
  expect(JSON.stringify(submittedDiagnostics)).not.toContain('Ship stopped moving');
  expect(snapshot.state['input']).toEqual({ liveTouches: 0 });
  expect(document.querySelector('[role="status"]')?.textContent).toContain('Not saved');
  expect(field.disabled).toBe(true);
  expect(document.querySelector('pre')?.textContent).toContain('Ship stopped moving');
  expect(document.querySelector('pre')?.textContent).toContain('session');
  client.dispose();
});

test.each(['pending', 'blocked', 'delivered'] as const)(
  'a restored %s receipt shows only its status and delivery controls',
  async (state) => {
    const id = crypto.randomUUID();
    let restoredView: DebugReportClientView | undefined;
    const restored = createDebugReportClient(
      (next) => {
        restoredView = next;
      },
      {
        origin: 'http://localhost',
        storage: {
          read: async () => ({
            kind: 'receipt',
            receipt: { id, state },
            receiptToken: 'a'.repeat(64),
          }),
          write: async () => {},
        },
        fetch: async () => new Response(JSON.stringify({ id, state }), { status: 200 }),
      }
    );
    await restored.restore();
    if (!restoredView) {
      throw new Error('Missing restored receipt');
    }
    form = mount(DebugReportForm, {
      target: document.body,
      props: {
        description: 'Unrelated draft',
        snapshot: { state: { sessionId: 'unrelated-incident' }, recentLogs: [] },
        view: restoredView,
        onsend: () => {},
        onretry: () => {},
        onnew: async () => false,
        onclose: () => {},
      },
    });
    flushSync();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('details')).toBeNull();
    expect(document.querySelector('pre')).toBeNull();
    const labels = [...document.querySelectorAll('button')].map((button) =>
      button.textContent?.trim()
    );
    expect(labels).not.toContain('Send');
    expect(labels).not.toContain('Copy report');
    expect(labels).not.toContain('Download report');
    expect(labels).toContain('New report');
    expect(labels).toContain('Close');
    expect(labels.includes('Retry / check delivery')).toBe(state !== 'delivered');
    expect(document.body.textContent).toContain(id);
    expect(document.body.textContent).not.toContain('Unrelated draft');
    expect(document.body.textContent).not.toContain('unrelated-incident');
    restored.dispose();
  }
);
