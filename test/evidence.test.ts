import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { createApp } from '../src/server/index.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE } from '../src/server/demo.js';

describe('downloading the screenshots of a run', () => {
  it('gives one folder: a picture of every step per test case, a summary, a CSV, and the before/after of a re-tested bug', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ev-')), timeoutMs: 120_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') =>
      (await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })).json() as Promise<any>;
    const runOnce = async (suite: number, page: string) => {
      const run = await call(`/api/suites/${suite}/run`, { appUrl: `${base}/demo/${page}` });
      for (let i = 0; i < 240; i++) {
        if (!['queued', 'running'].includes((await call('/api/runs/' + run.id)).status)) return run.id as string;
        await new Promise((x) => setTimeout(x, 250));
      }
      throw new Error('run did not finish');
    };
    try {
      const made = await call('/api/usecases/generate', { title: 'Sign in', text: DEMO_USE_CASE, testData: Object.entries(DEMO_TEST_DATA).map(([k, v]) => `${k}=${v}`).join('\n'), method: 'rules' });
      const id = made.suite.id;
      // One case passes; one fails on the old page and passes once the fix is out (the v1 page has no "Welcome back" banner text).
      await call('/api/suites/' + id, { cases: [
        { id: 'TC-001', title: 'Sign in works', steps: made.suite.cases[0].steps, expected: '' },
        { id: 'TC-002', title: 'Banner after sign in', steps: [...made.suite.cases[0].steps.slice(0, 4), 'Verify "Acme" is displayed'], expected: '' },
      ] }, 'PUT');
      const first = await runOnce(id, 'login?v=1');
      const early = await fetch(`${base}/api/runs/${first}/screenshots.zip`);
      assert.equal(early.status, 200);

      // Re-test after marking the bug fixed: make TC-002 fail first, then pass.
      await call('/api/suites/' + id, { cases: [
        { id: 'TC-001', title: 'Sign in works', steps: made.suite.cases[0].steps, expected: '' },
        { id: 'TC-002', title: 'Banner after sign in', steps: [...made.suite.cases[0].steps.slice(0, 4), 'Verify "Order history" is displayed'], expected: '' },
      ] }, 'PUT');
      const failing = await runOnce(id, 'login?v=1');
      const bug = (await call(`/api/runs/${failing}/report`)).bugs.find((b: any) => /TC-002/.test(b.test));
      assert.ok(bug, 'TC-002 failed and became a bug');
      await call(`/api/runs/${failing}/bugs/${bug.id}`, { status: 'fixed' }, 'PATCH');
      await call('/api/suites/' + id, { cases: [
        { id: 'TC-001', title: 'Sign in works', steps: made.suite.cases[0].steps, expected: '' },
        { id: 'TC-002', title: 'Banner after sign in', steps: [...made.suite.cases[0].steps.slice(0, 4), 'Verify "Acme" is displayed'], expected: '' },
      ] }, 'PUT');
      const retest = await runOnce(id, 'login?v=1');
      assert.equal((await call(`/api/runs/${retest}/report`)).bugs.find((b: any) => b.id === bug.id).status, 'verified');

      const res = await fetch(`${base}/api/runs/${retest}/screenshots.zip`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/zip');
      assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="EasyTesting - Sign in - \d{4}-\d\d-\d\d \d\d-\d\d\.zip"/);
      const files = Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer())));
      const folder = files[0].split('/')[0];
      assert.ok(files.every((f) => f.startsWith(folder + '/')), 'everything is in one folder');
      assert.ok(files.includes(`${folder}/Open me - summary.html`) && files.includes(`${folder}/results.csv`));
      const tc1 = files.filter((f) => f.startsWith(`${folder}/TC-001 Sign in works/`));
      assert.equal(tc1.length, made.suite.cases[0].steps.length, 'a picture for every step: ' + tc1.join(', '));
      assert.ok(tc1[0].endsWith('/01 passed - Open the application.jpg'), tc1[0]);
      const evidence = files.filter((f) => f.includes('/Re-test evidence/'));
      assert.equal(evidence.length, 2, evidence.join(', '));
      assert.ok(evidence.some((f) => new RegExp(`before - failed in run ${failing}\\.png$`).test(f)), 'the picture from when it failed');
      assert.ok(evidence.some((f) => new RegExp(`after - passed in run ${retest}\\.jpg$`).test(f)), 'and from the re-test');
    } finally {
      server.close();
    }
  });
});
