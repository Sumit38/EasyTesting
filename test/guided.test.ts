import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_TEST_DATA, DEMO_USE_CASE } from '../src/server/demo.js';
import { createApp } from '../src/server/index.js';
import { writeXlsx, readXlsx } from '../src/server/xlsx.js';
import { writeCsv } from '../src/server/csv.js';
import { strToU8, zipSync } from 'fflate';

const require_fflate = () => ({ strToU8, zipSync });

describe('the guided path: use case to cases to run to report', () => {
  let web: Server;
  let base = '';
  const api = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(init.json);
    }
    const res = await fetch(base + path, { ...init, headers });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? ((await res.json()) as any) : Buffer.from(await res.arrayBuffer()), res };
  };
  before(async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'guided-')), timeoutMs: 180_000 });
    web = server;
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  after(() => web.close());

  const finish = async (id: string) => {
    for (let i = 0; i < 360; i++) {
      const r = (await api('/api/runs/' + id)).body;
      if (!['queued', 'installing', 'running'].includes(r.status)) {
        await new Promise((x) => setTimeout(x, 600));
        return r;
      }
      await new Promise((x) => setTimeout(x, 500));
    }
    throw new Error('run did not finish');
  };

  let suiteId = 0;

  it('says whether the AI helper is available, and serves the example', async () => {
    const ai = await api('/api/ai');
    assert.equal(typeof ai.body.available, 'boolean');
    const ex = await api('/api/example');
    assert.match(ex.body.useCase, /Sign in to Acme/);
  });

  it('turns a use case into test cases (rule-based by default) and reads each step', async () => {
    const out = await api('/api/usecases/generate', { method: 'POST', json: { text: DEMO_USE_CASE, testData: DEMO_TEST_DATA } });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.by, 'rules');
    const suite = out.body.suite;
    suiteId = suite.id;
    assert.equal(suite.source, 'generated');
    assert.ok(suite.cases.length >= 8);
    for (const c of suite.cases) for (const s of c.interpreted) assert.ok(s.confidence >= 0.6 && s.action !== 'unknown', s.text);
    assert.equal((await api('/api/usecases/generate', { method: 'POST', json: { text: 'too short' } })).status, 400);
  });

  it('falls back to rules with a reason when AI is asked for but not set up', async () => {
    const saved = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const out = await api('/api/usecases/generate', { method: 'POST', json: { text: DEMO_USE_CASE, method: 'ai' } });
      assert.equal(out.body.by, 'rules');
      assert.match(out.body.fallbackReason, /API key/);
      assert.equal((await api('/api/steps/improve', { method: 'POST', json: { steps: ['x'] } })).status, 409);
    } finally {
      if (saved[0]) process.env.ANTHROPIC_API_KEY = saved[0];
      if (saved[1]) process.env.ANTHROPIC_AUTH_TOKEN = saved[1];
    }
  });

  it('downloads the cases as Excel and CSV', async () => {
    const x = await api(`/api/suites/${suiteId}/download?format=xlsx`);
    assert.match(x.res.headers.get('content-disposition') ?? '', /\.xlsx"/);
    const rows = readXlsx(new Uint8Array(x.body as Buffer));
    assert.deepEqual(rows[0].slice(0, 6), ['Test Case ID', 'Scenario Name', 'Test Case Name', 'Precondition', 'Test Case Steps', 'Expected Results']);
    assert.ok(rows.length > 8);
    const c = await api(`/api/suites/${suiteId}/download?format=csv`);
    assert.match((c.body as Buffer).toString('utf8'), /^﻿Test Case ID,Scenario Name,Test Case Name,Precondition,Test Case Steps,Expected Results,Requirement Type/);
  });

  it('reads an uploaded sheet, asks for the column mapping, and builds the same cases', async () => {
    const original = (await api('/api/suites/' + suiteId)).body;
    // A tester's own layout: different header names, a column we do not use, steps in one cell.
    const rows = [
      ['Ref', 'Scenario', 'Test Steps', 'Expected Outcome', 'Owner'],
      ...original.cases.slice(0, 3).map((c: any, i: number) => [`LG-${i + 1}`, c.title, c.steps.map((s: string, n: number) => `${n + 1}. ${s}`).join('\n'), c.expected, 'Sam']),
    ];
    const up = await api('/api/imports?filename=my-cases.xlsx', { method: 'POST', body: Buffer.from(writeXlsx(rows)) });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.hasHeader, true);
    assert.equal(up.body.mapping.id, 0);
    assert.equal(up.body.mapping.title, 1);
    assert.equal(up.body.mapping.steps, 2);
    assert.equal(up.body.mapping.expected, 3);
    assert.equal(up.body.preview.length, 3);

    const noSteps = await api(`/api/imports/${up.body.importId}/confirm`, { method: 'POST', json: { mapping: { ...up.body.mapping, steps: -1 } } });
    assert.equal(noSteps.status, 400);

    const ok = await api(`/api/imports/${up.body.importId}/confirm`, { method: 'POST', json: { mapping: up.body.mapping, hasHeader: true, title: 'My login cases' } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.suite.source, 'uploaded');
    assert.deepEqual(ok.body.suite.cases.map((c: any) => c.id), ['LG-1', 'LG-2', 'LG-3']);
    assert.deepEqual(ok.body.suite.cases[0].steps, original.cases[0].steps);

    // The same sheet as CSV works too.
    const csv = await api('/api/imports?filename=my-cases.csv', { method: 'POST', body: Buffer.from(writeCsv(rows)) });
    assert.equal(csv.body.mapping.steps, 2);
    assert.equal((await api('/api/imports?filename=old.xls', { method: 'POST', body: Buffer.from('x') })).status, 400);
  });

  it('runs the cases in a browser, step by step, and the report covers them', async () => {
    const started = await api(`/api/suites/${suiteId}/run`, { method: 'POST', json: { appUrl: `${base}/demo/login?v=1` } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    assert.equal(started.body.kind, 'cases');
    const run = await finish(started.body.id);
    assert.equal(run.status, 'passed', (await api(`/api/runs/${run.id}/log`)).body.toString());

    const steps = (await api(`/api/runs/${run.id}/steps`)).body;
    assert.ok(steps.cases.length >= 8);
    const main = steps.cases.find((c: any) => /main flow/.test(c.title));
    assert.equal(main.status, 'passed');
    assert.ok(main.confidence >= 85 && main.understanding >= 90);
    assert.ok(main.steps.every((s: any) => s.status === 'passed'));

    const report = (await api(`/api/runs/${run.id}/report`)).body;
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.passed, steps.cases.length);
    assert.ok(report.coverage.pages.visited >= 2, 'login and dashboard were visited');
    assert.equal(report.bugs.length, 0);
  });

  it('a case that really fails becomes a bug, with a screenshot and advice', async () => {
    const edited = (await api('/api/suites/' + suiteId)).body;
    edited.cases = edited.cases.slice(0, 1);
    edited.cases[0].steps[edited.cases[0].steps.length - 1] = 'Verify "Welcome back, Alex" is displayed';
    assert.equal((await api('/api/suites/' + suiteId, { method: 'PUT', json: edited })).status, 200);
    const started = await api(`/api/suites/${suiteId}/run`, { method: 'POST', json: { appUrl: `${base}/demo/login?v=1` } });
    const run = await finish(started.body.id);
    assert.equal(run.status, 'failed');
    const steps = (await api(`/api/runs/${run.id}/steps`)).body;
    const failed = steps.cases[0].steps.find((s: any) => s.status === 'failed');
    assert.match(failed.error, /not on the page/);
    assert.match(steps.cases[0].advice, /real defect/);
    const shot = await api(`/api/runs/${run.id}/shots/${failed.screenshot}`);
    assert.equal(shot.status, 200);
    assert.equal(shot.res.headers.get('content-type'), 'image/png');
    assert.equal((await api(`/api/runs/${run.id}/shots/..%2F..%2Frun.json`)).status, 404);

    const report = (await api(`/api/runs/${run.id}/report`)).body;
    assert.equal(report.bugs.length, 1);
    assert.equal(report.bugs[0].status, 'open');
  });

  it('re-running a cases run starts the same cases again', async () => {
    const runs = (await api('/api/runs')).body as any[];
    const last = runs.find((r) => r.kind === 'cases');
    const again = await api(`/api/runs/${last.id}/rerun`, { method: 'POST' });
    assert.equal(again.status, 202);
    assert.equal(again.body.kind, 'cases');
    assert.equal(again.body.suite, last.suite);
    await finish(again.body.id);
  });

  it('refuses a run with no app link or no steps', async () => {
    assert.equal((await api(`/api/suites/${suiteId}/run`, { method: 'POST', json: { appUrl: 'not a link' } })).status, 400);
    const empty = (await api('/api/usecases/generate', { method: 'POST', json: { text: DEMO_USE_CASE } })).body.suite;
    await api('/api/suites/' + empty.id, { method: 'PUT', json: { cases: [{ id: 'A', title: 'No steps', steps: [], expected: '' }] } });
    assert.equal((await api(`/api/suites/${empty.id}/run`, { method: 'POST', json: { appUrl: `${base}/demo/login` } })).status, 400);
  });

  it('interprets steps on demand, for editing', async () => {
    const out = await api('/api/steps/interpret', { method: 'POST', json: { steps: ['Click the Save button', 'Do the needful'] } });
    assert.equal(out.body.steps[0].action, 'click');
    assert.equal(out.body.steps[1].action, 'unknown');
    assert.match(out.body.steps[0].summary, /Click/);
  });
});

describe('suites belong to their owner', () => {
  it('another tester cannot open, run or download them', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'guided2-')), accounts: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = () => {
      let cookie = '';
      return async (path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') => {
        const res = await fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
      };
    };
    try {
      const admin = client();
      await admin('/api/auth/setup', { email: 'a@x.io', name: 'A', password: 'admin-password' });
      await admin('/api/users', { email: 'ann@x.io', name: 'Ann', password: 'ann-password' });
      await admin('/api/users', { email: 'bob@x.io', name: 'Bob', password: 'bob-password' });
      const ann = client();
      const bob = client();
      await ann('/api/auth/login', { email: 'ann@x.io', password: 'ann-password' });
      await bob('/api/auth/login', { email: 'bob@x.io', password: 'bob-password' });
      const made = await ann('/api/usecases/generate', { text: DEMO_USE_CASE });
      const id = made.body.suite.id;
      assert.equal((await ann('/api/suites/' + id)).status, 200);
      assert.equal((await bob('/api/suites/' + id)).status, 404);
      assert.equal((await bob(`/api/suites/${id}/run`, { appUrl: 'http://x.io' })).status, 404);
      assert.equal((await bob('/api/suites/' + id, undefined, 'DELETE')).status, 404);
      assert.equal((await bob('/api/suites')).body.length, 0);
      assert.equal((await ann('/api/suites')).body.length, 1);
      assert.equal((await admin('/api/suites')).body.length, 1, 'the admin sees every suite');
    } finally {
      server.close();
    }
  });
});

describe('hosting limits', () => {
  it('queues runs beyond the limit, then runs them in turn', async () => {
    const { runs } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'limit-')), maxConcurrent: 1 });
    const make = (name: string) => {
      const { zipSync, strToU8 } = require_fflate();
      return runs.create({ name, framework: 'custom', appUrl: '', command: 'node -e "setTimeout(()=>{},1500)"', install: false, filename: 'p.zip', upload: Buffer.from(zipSync({ 'a.js': strToU8('1') })) });
    };
    const a = make('first');
    const b = make('second');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(runs.get(a.id)!.status, 'running');
    assert.equal(runs.get(b.id)!.status, 'queued', 'the second waits for a free slot');
    for (let i = 0; i < 40 && runs.get(b.id)!.status !== 'passed'; i++) await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs.get(a.id)!.status, 'passed');
    assert.equal(runs.get(b.id)!.status, 'passed');
  });

  it('a run deleted while it waits is simply skipped', async () => {
    const { runs } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'limit2-')), maxConcurrent: 1 });
    const { zipSync, strToU8 } = require_fflate();
    const up = Buffer.from(zipSync({ 'a.js': strToU8('1') }));
    const a = runs.create({ name: 'a', framework: 'custom', appUrl: '', command: 'node -e "setTimeout(()=>{},1200)"', install: false, filename: 'p.zip', upload: up });
    const b = runs.create({ name: 'b', framework: 'custom', appUrl: '', command: 'node -e "1"', install: false, filename: 'p.zip', upload: up });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs.delete(b.id), true);
    for (let i = 0; i < 30 && runs.get(a.id)!.status !== 'passed'; i++) await new Promise((r) => setTimeout(r, 300));
    assert.equal(runs.get(a.id)!.status, 'passed', 'the server did not crash and the other run finished');
  });

  it('refuses test-code uploads when they are turned off, but still serves everything else', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'nocode-')), allowCodeUploads: false });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await (await fetch(base + '/healthz')).json()).ok, true);
      assert.equal((await (await fetch(base + '/api/auth/state')).json()).codeUploads, false);
      const up = await fetch(base + '/api/runs?name=x&filename=p.zip', { method: 'POST', body: Buffer.from([80, 75, 3, 4]) });
      assert.equal(up.status, 403);
      assert.match((await up.json()).error, /turned off/);
      const gen = await fetch(base + '/api/usecases/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: DEMO_USE_CASE }) });
      assert.equal(gen.status, 201, 'use cases and test cases are unaffected');
    } finally {
      server.close();
    }
  });
});
