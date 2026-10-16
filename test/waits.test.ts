import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../src/cases/model.js';
import { rank } from '../src/exec/resolve.js';
import { runCases } from '../src/exec/runner.js';
import type { UINode } from '../src/model.js';
import { createApp } from '../src/server/index.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE } from '../src/server/demo.js';

/** A site that is slow and awkward on purpose. */
const PAGES: Record<string, string> = {
  '/late-paint': `<body></body><script>setTimeout(() => { document.body.innerHTML = '<h1>Products</h1><p>All the things we sell.</p>'; }, 2000)</script>`,
  '/never-paints': `<body style="background:#fff"></body>`,
  '/late-button': `<body><h1>Checkout</h1></body><script>setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Pay now'; b.onclick = () => document.body.insertAdjacentHTML('beforeend', '<p>Paid</p>'); document.body.append(b); }, 10000)</script>`,
  '/start': `<body><h1>Home</h1><a href="/slow-target">Orders</a></body>`,
  '/login': `<body><h1>Shop</h1><form id="login"><h2>Login to your account</h2><input placeholder="Email Address"><input type="password" placeholder="Password"><button type="button" onclick="document.body.insertAdjacentHTML('beforeend','<p>Checking '+document.querySelector('#login input').value+'</p>')">Login</button></form>
    <form id="signup"><h2>New user</h2><input placeholder="Name"><input placeholder="Email Address"></form>
    <footer><h3>Subscription</h3><input placeholder="Your email address" style="width:200px"></footer></body>`,
};

describe('slow pages and pictures', () => {
  let site: Server;
  let origin = '';
  before(async () => {
    site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const send = (html: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><head><title>Test shop</title></head>${html}</html>`); };
      if (path === '/slow-target') return void setTimeout(() => send('<body><h1>Your orders</h1><p>Order 1001</p></body>'), 4000); // the server takes 4 s to answer
      const page = PAGES[path];
      if (!page) { res.writeHead(404); return void res.end('no'); }
      send(page);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  const one = async (steps: string[], extra: Partial<Parameters<typeof runCases>[0]> = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'waits-'));
    const cases: TestCase[] = [{ id: 'TC-1', title: 't', steps, expected: '' }];
    const { results } = await runCases({ cases, appUrl: origin + '/start', healDir: dir, storeFile: join(dir, 'fp.db'), ...extra });
    return { r: results[0], shots: join(dir, 'shots') };
  };

  it('keeps no blank picture: it waits for the page to show something first', async () => {
    const { r, shots } = await one(['Open "/late-paint"', 'Verify "All the things we sell" is displayed']);
    assert.equal(r.status, 'passed', JSON.stringify(r.steps.map((s) => s.error)));
    const first = r.steps[0];
    assert.ok(first.evidence, 'the first step has its picture');
    assert.ok(statSync(join(shots, first.evidence!)).size > 6900, 'and it is not a blank one');
  });

  it('rather than keep a blank picture, keeps none and says why', async () => {
    const { r, shots } = await one(['Open "/never-paints"']);
    assert.equal(r.steps[0].status, 'passed');
    assert.equal(r.steps[0].evidence, undefined);
    assert.match(r.steps[0].notes.join(' '), /No picture was kept/);
    assert.deepEqual(readdirSync(shots), []);
  });

  it('waits for an element that appears late (10 s), where the old 8 s limit gave up', async () => {
    const { r } = await one(['Open "/late-button"', 'Click the "Pay now" button', 'Verify "Paid" is displayed']);
    assert.equal(r.status, 'passed', JSON.stringify(r.steps.map((s) => [s.text, s.status, s.error])));
  });

  it('after a click, waits for a slow next page before checking it', async () => {
    const { r } = await one(['Open "/start"', 'Click "Orders"', 'Verify the page title contains "Test shop"', 'Verify "Order 1001" is displayed'], { stepTimeout: 2000 });
    assert.equal(r.status, 'passed', JSON.stringify(r.steps.map((s) => [s.text, s.status, s.error])));
  });

  it('types into the login form, not the newsletter box, when several fields share a name', async () => {
    const { r } = await one(['Open "/login"', 'Enter "sam@example.com" in the Email Address field', 'Enter "secret" in the Password field', 'Click the "Login" button', 'Verify "Checking sam@example.com" is displayed']);
    assert.equal(r.status, 'passed', JSON.stringify(r.steps.map((s) => [s.text, s.status, s.matchedAs, s.error])));
  });
});

describe('choosing between elements with the same name', () => {
  const node = (name: string, cssPath: string, y: number, w = 360): UINode => ({ tag: 'input', role: 'textbox', name, text: '', attrs: { placeholder: name }, classes: [], ancestors: [], siblingIndex: 0, rect: { x: 100, y, w, h: 40 }, cssPath });
  const login = node('Email Address', 'body form#a input:nth-child(1)', 300);
  const signup = node('Email Address', 'body form#b input:nth-child(2)', 350);
  const news = node('Your email address', 'body footer input', 700, 200);
  const password = node('Password', 'body form#b input:nth-child(3)', 400);

  it('prefers the exact words over a match that only holds without "your"', () => {
    assert.equal(rank([news, login], 'Email Address', 'field').best?.node, login);
  });
  it('then the one a person reads first', () => {
    assert.equal(rank([news, signup, login], 'Email Address', 'field').best?.node, login);
  });
  it('then the one in the same form as the previous step', () => {
    assert.equal(rank([news, signup, login], 'Email Address', 'field', 'act', password).best?.node, signup);
  });
});

describe('the page speed of a run', () => {
  it('is saved with the run, so its runner waits as long as asked', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'speed-'));
    const { server } = createApp({ dataDir, timeoutMs: 120_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') => (await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) })).json() as Promise<any>;
    try {
      const made = await call('/api/usecases/generate', { text: DEMO_USE_CASE, testData: Object.entries(DEMO_TEST_DATA).map(([k, v]) => `${k}=${v}`).join('\n'), method: 'rules' });
      const run = await call(`/api/suites/${made.suite.id}/run`, { appUrl: `${base}/demo/login?v=1`, speed: 'very-slow' });
      const saved = JSON.parse(readFileSync(join(dataDir, 'runs', run.id, 'project', 'cases.json'), 'utf8'));
      assert.equal(saved.speed, 'very-slow');
      const bad = await call(`/api/suites/${made.suite.id}/run`, { appUrl: `${base}/demo/login?v=1`, speed: 'forever' });
      assert.equal(JSON.parse(readFileSync(join(dataDir, 'runs', bad.id, 'project', 'cases.json'), 'utf8')).speed, 'normal', 'anything else is Normal');
      for (const id of [run.id, bad.id]) await call(`/api/runs/${id}/stop`, {});
    } finally {
      server.close();
    }
  });
});
