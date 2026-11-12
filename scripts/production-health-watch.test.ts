import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'vitest';
import { parse } from 'yaml';
import { runProductionHealthWatch } from './production-health-watch.ts';

const marker = '<!-- georoids-production-health-watch:v1 -->';
const healthy = { status: 'healthy', world: { persistence: { mode: 'worker', failed: false } } };
type Sample = { status: number; value: unknown } | { hang: 'headers' | 'body' } | { raw: string };
type Issue = {
  number: number;
  state: 'open' | 'closed';
  body: string;
  user: { login: string; type: string };
};
type Mutation = { method: string; path: string; body: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fixture(
  run: (context: {
    watch: () => ReturnType<typeof runProductionHealthWatch>;
    samples: Sample[];
    issues: Issue[];
    mutations: Mutation[];
    failAfterCreate: () => void;
    rejectApi: () => void;
  }) => Promise<void>
): Promise<void> {
  const samples: Sample[] = [];
  const issues: Issue[] = [];
  const mutations: Mutation[] = [];
  let failCreate = false;
  let apiRejected = false;
  let nextIssue = 1;
  function reply(response: ServerResponse, value: unknown, status = 200): void {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    if (request.url === '/health') {
      assert.equal(request.headers['authorization'], undefined);
      const sample = samples.shift();
      assert(sample, 'Every health probe needs an explicit fixture response');
      if ('hang' in sample) {
        if (sample.hang === 'body') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{"private":"unfinished');
        }
        return;
      }
      if ('raw' in sample) {
        response.writeHead(200);
        response.end(sample.raw);
      } else {
        reply(response, sample.value, sample.status);
      }
      return;
    }
    assert.equal(request.headers['authorization'], 'Bearer fixture-token');
    if (apiRejected) {
      reply(response, { secret: 'PRIVATE-API-RESPONSE' }, 403);
      return;
    }
    if (request.method === 'GET') {
      const page = Number(new URL(request.url ?? '', 'http://fixture').searchParams.get('page'));
      reply(response, issues.slice((page - 1) * 100, page * 100));
      return;
    }
    let text = '';
    for await (const chunk of request) {
      text += String(chunk);
    }
    const body: unknown = JSON.parse(text);
    assert(isRecord(body));
    mutations.push({ method: request.method ?? '', path: request.url ?? '', body });
    if (request.method === 'POST') {
      assert(typeof body['body'] === 'string');
      issues.push({
        number: nextIssue++,
        state: 'open',
        body: body['body'],
        user: { login: 'github-actions[bot]', type: 'Bot' },
      });
      if (failCreate) {
        failCreate = false;
        response.destroy();
        return;
      }
    } else {
      const issue = issues.find((value) => request.url?.endsWith(`/${value.number}`));
      assert(issue);
      assert(body['state'] === 'open' || body['state'] === 'closed');
      assert(typeof body['body'] === 'string');
      issue.state = body['state'];
      issue.body = body['body'];
    }
    reply(response, issues.at(-1), 200);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname + new URL(url).search;
    const response = await fetch(`${origin}${path}`, init);
    // Keep the production canonical-URL check while executing actual loopback HTTP.
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };
  try {
    await run({
      watch: () =>
        runProductionHealthWatch({
          token: 'fixture-token',
          healthFetcher: fetcher,
          apiFetcher: fetcher,
          timeoutMs: 1000,
          sleep: () => Promise.resolve(),
        }),
      samples,
      issues,
      mutations,
      failAfterCreate: () => {
        failCreate = true;
      },
      rejectApi: () => {
        apiRejected = true;
      },
    });
    assert.equal(samples.length, 0, 'All arranged probes must run');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function arrange(samples: Sample[], ...values: unknown[]): void {
  samples.push(...values.map((value) => ({ status: 200, value })));
}

test('a healthy first run creates no incident or notification', async () => {
  await fixture(async ({ watch, samples, issues, mutations }) => {
    arrange(samples, healthy, healthy);
    assert.deepEqual(await watch(), {
      observation: { kind: 'healthy', attempts: 2 },
      action: 'none',
    });
    assert.equal(issues.length, 0);
    assert.deepEqual(mutations, []);
  });
});

test('an outage opens one issue, stays quiet, closes after recovery and reuses it', async () => {
  await fixture(async ({ watch, samples, issues, mutations }) => {
    const down = () =>
      samples.push(
        ...Array.from({ length: 3 }, () => ({ status: 503, value: { private: 'PRIVATE-HEALTH' } }))
      );
    down();
    assert.equal((await watch()).action, 'created');
    down();
    assert.equal((await watch()).action, 'none');
    assert.equal(issues.length, 1);
    assert.equal(mutations.length, 1);
    assert(issues[0]?.body.includes('@jsolly'));
    assert(issues[0]?.body.includes("\\- John Solly's AI Assistant"));
    assert(issues[0]?.body.includes('<!-- agent: github-actions -->'));
    assert(!JSON.stringify(mutations).includes('PRIVATE-HEALTH'));
    arrange(samples, healthy, healthy);
    assert.equal((await watch()).action, 'updated');
    assert.equal(issues[0]?.state, 'closed');
    arrange(samples, healthy, healthy);
    assert.equal((await watch()).action, 'none');
    down();
    assert.equal((await watch()).action, 'updated');
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.state, 'open');
    assert.deepEqual(
      mutations.map((value) => value.method),
      ['POST', 'PATCH', 'PATCH']
    );
  });
});

test('mixed probes neither open an incident nor close an existing outage', async () => {
  await fixture(async ({ watch, samples, issues, mutations }) => {
    const bad = { status: 503, value: {} };
    samples.push(bad, { status: 200, value: healthy }, bad);
    assert.equal((await watch()).observation.kind, 'transient');
    assert.equal(mutations.length, 0);
    samples.push(bad, bad, bad);
    await watch();
    samples.push({ status: 200, value: healthy }, bad, { status: 200, value: healthy });
    assert.equal((await watch()).observation.kind, 'transient');
    assert.equal(issues[0]?.state, 'open');
    assert.equal(mutations.length, 1);
    samples.push(bad, { status: 200, value: healthy }, { status: 200, value: healthy });
    assert.equal((await watch()).action, 'updated');
    assert.equal(issues[0]?.state, 'closed');
  });
});

test.each([
  {
    name: 'failed worker',
    value: { status: 'healthy', world: { persistence: { mode: 'worker', failed: true } } },
    reason: 'persistence-failed',
  },
  {
    name: 'disabled worker',
    value: { status: 'healthy', world: { persistence: { mode: 'inline', failed: false } } },
    reason: 'invalid-health',
  },
  {
    name: 'missing failed flag',
    value: { status: 'healthy', world: { persistence: { mode: 'worker' } } },
    reason: 'invalid-health',
  },
  {
    name: 'missing status',
    value: { world: { persistence: { mode: 'worker', failed: false } } },
    reason: 'invalid-health',
  },
])('$name alerts with a sanitized reason', async ({ value, reason }) => {
  await fixture(async ({ watch, samples, issues }) => {
    arrange(samples, value, value, value);
    assert.deepEqual((await watch()).observation, { kind: 'incident', attempts: 3, reason });
    assert(issues[0]?.body.includes(`Production health: ${reason}.`));
  });
});

test('parser failures and bounded stalled HTTP requests alert without leaking data', async () => {
  await fixture(async ({ watch, samples, issues }) => {
    samples.push({ raw: 'PRIVATE-BODY' }, { hang: 'headers' }, { hang: 'body' });
    assert.equal((await watch()).action, 'created');
    assert(!issues[0]?.body.includes('PRIVATE-BODY'));
    assert(issues[0]?.body.includes('Production health: unavailable.'));
  });
});

test('an ambiguous created response is discovered on the next run without duplicate POST', async () => {
  await fixture(async ({ watch, samples, issues, mutations, failAfterCreate }) => {
    failAfterCreate();
    samples.push(...Array.from({ length: 6 }, () => ({ status: 503, value: {} })));
    await assert.rejects(watch(), /GitHub health watch operation failed/u);
    assert.equal((await watch()).action, 'none');
    assert.equal(issues.length, 1);
    assert.equal(mutations.length, 1);
  });
});

test('a monitor issue beyond the first API page is reused and changed reasons update once', async () => {
  await fixture(async ({ watch, samples, issues, mutations }) => {
    for (let number = 1000; number < 1100; number++) {
      issues.push({
        number,
        state: 'open',
        body: 'Unrelated automation issue',
        user: { login: 'github-actions[bot]', type: 'Bot' },
      });
    }
    issues.push({
      number: 1100,
      state: 'open',
      body: `${marker}\nold reason`,
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    const failed = { status: 'healthy', world: { persistence: { mode: 'worker', failed: true } } };
    arrange(samples, failed, failed, failed);
    assert.equal((await watch()).action, 'updated');
    arrange(samples, failed, failed, failed);
    assert.equal((await watch()).action, 'none');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.path, '/repos/jsolly/GeoRoids/issues/1100');
    assert.equal(issues.length, 101);
  });
});

test('a matching title or forged marker by another author is never changed', async () => {
  await fixture(async ({ watch, samples, issues, mutations }) => {
    issues.push({
      number: 900,
      state: 'open',
      body: `${marker}\nforged`,
      user: { login: 'someone', type: 'User' },
    });
    issues.push({
      number: 901,
      state: 'open',
      body: 'Production server health incident',
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    samples.push(...Array.from({ length: 3 }, () => ({ status: 503, value: {} })));
    assert.equal((await watch()).action, 'created');
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0]?.method, 'POST');
    assert.equal(issues[0]?.body, `${marker}\nforged`);
  });
});

test('duplicate owned issues and GitHub API failures fail visibly without mutations', async () => {
  await fixture(async ({ watch, samples, issues, mutations, rejectApi }) => {
    const user = { login: 'github-actions[bot]', type: 'Bot' };
    issues.push(
      { number: 1, state: 'open', body: `${marker}\na`, user },
      { number: 2, state: 'closed', body: `${marker}\nb`, user }
    );
    arrange(samples, healthy, healthy);
    await assert.rejects(watch(), /Multiple monitor-owned issues/u);
    rejectApi();
    arrange(samples, healthy, healthy);
    await assert.rejects(watch(), (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes('PRIVATE-API-RESPONSE'));
      return error.message.includes('GitHub health watch operation failed');
    });
    assert.equal(mutations.length, 0);
  });
});

test('scheduled and manual watches share a serial queue outside CI and deploy gates', async () => {
  const source = await readFile(
    new URL('../.github/workflows/production-health-watch.yml', import.meta.url),
    'utf8'
  );
  const workflow: unknown = parse(source);
  assert(typeof workflow === 'object' && workflow !== null && 'concurrency' in workflow);
  assert.deepEqual(workflow.concurrency, {
    group: 'production-health-watch',
    'cancel-in-progress': false,
  });
  assert(source.includes("cron: '3-58/5 * * * *'"));
  assert(source.includes('issues: write'));
  assert(source.includes('persist-credentials: false'));
  assert(!source.includes('workflow_run:'));
  assert(!source.includes('deployment_status:'));
});
