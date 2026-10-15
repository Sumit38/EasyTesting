import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE } from '../src/server/demo.js';

describe('stopping a test run', () => {
  it('ends a running test-case run as Stopped, and a queued one never starts', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'stop-')), maxConcurrent: 1, timeoutMs: 120_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, json?: unknown) => (await fetch(base + path, { method: json === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })).json() as Promise<any>;
    const waitFor = async (id: string, done: (r: any) => boolean) => {
      for (let i = 0; i < 240; i++) {
        const r = await call('/api/runs/' + id);
        if (done(r)) return r;
        await new Promise((x) => setTimeout(x, 250));
      }
      throw new Error('run did not get there');
    };
    try {
      const made = await call('/api/usecases/generate', { text: DEMO_USE_CASE, testData: Object.entries(DEMO_TEST_DATA).map(([k, v]) => `${k}=${v}`).join('\n'), method: 'rules' });
      const appUrl = `${base}/demo/login?v=1`;
      const first = await call(`/api/suites/${made.suite.id}/run`, { appUrl });
      const second = await call(`/api/suites/${made.suite.id}/run`, { appUrl });
      assert.equal((await call('/api/runs/' + second.id)).status, 'queued', 'one run at a time here, so the second waits');

      assert.equal((await call(`/api/runs/${second.id}/stop`, {})).stopped, true);
      assert.equal((await call('/api/runs/' + second.id)).status, 'stopped');

      // Stop the first once it has finished at least one step.
      await waitFor(first.id, () => true);
      for (let i = 0; i < 240; i++) {
        const steps = await call(`/api/runs/${first.id}/steps`);
        if ((steps.cases ?? []).some((c: any) => c.steps.some((s: any) => s.status === 'passed'))) break;
        await new Promise((x) => setTimeout(x, 250));
      }
      await call(`/api/runs/${first.id}/stop`, {});
      const ended = await waitFor(first.id, (r) => !['queued', 'installing', 'running'].includes(r.status));
      assert.equal(ended.status, 'stopped');
      const steps = await call(`/api/runs/${first.id}/steps`);
      assert.ok(steps.cases.some((c: any) => c.status === 'skipped'), 'the rest were not run');
      const report = await call(`/api/runs/${first.id}/report`);
      assert.equal(report.bugs.length, 0, 'stopping is not a failure, so no bug is raised');
      assert.equal((await call('/api/runs/' + second.id)).status, 'stopped', 'the queued run stayed stopped when a slot freed up');
    } finally {
      server.close();
    }
  });
});
