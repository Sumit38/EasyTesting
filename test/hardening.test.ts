import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../src/cases/model.js';
import { blockedReason, isPrivateAddress } from '../src/exec/guard.js';
import { runCases } from '../src/exec/runner.js';
import { createApp } from '../src/server/index.js';
import { DEMO_USE_CASE, demoPage } from '../src/server/demo.js';
import { RunManager } from '../src/server/runs.js';

describe('which addresses a test may open', () => {
  it('recognises private, local and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });

  it('refuses files, this machine, private networks and cloud metadata, and allows public sites and the built-in demo', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'http://localhost:8080/api/users', 'http://127.0.0.1:4173/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://db.railway.internal:5432/', 'http://2130706433/', 'not a url']) {
      assert.ok(await blockedReason(url), `should be refused: ${url}`);
    }
    assert.equal(await blockedReason('http://93.184.216.34/'), undefined);
    assert.equal(await blockedReason('http://127.0.0.1:4173/demo/app?v=1'), undefined, 'the sample site served by this app');
    assert.ok(await blockedReason('http://127.0.0.1:4173/api/users'), 'but nothing else on this machine');
  });
});

describe('a test case cannot read the server', () => {
  let site: Server;
  let origin = '';
  before(async () => {
    site = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const page = demoPage(u.pathname, u.searchParams.get('v') ?? '1');
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      res.end(page ?? 'secret page');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  const caseWith = (id: string, step: string): TestCase => ({ id, title: step, steps: [step], expected: '' });

  it('stops a step that opens a private address, cloud metadata or the server itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    const cases = [
      caseWith('G-1', 'Open "//169.254.169.254/latest/meta-data/"'),
      caseWith('G-2', 'Open "http://169.254.169.254/latest/meta-data/"'),
      caseWith('G-3', `Open "${origin}/api/users"`),
      caseWith('G-4', 'Open "/demo/login?v=1"'),
    ];
    const { results } = await runCases({ cases, appUrl: `${origin}/demo/login?v=1`, healDir: dir, storeFile: join(dir, 'fp.db'), stepTimeout: 3000, blockPrivate: true });
    const by = Object.fromEntries(results.map((r) => [r.id, r]));
    for (const id of ['G-1', 'G-2', 'G-3']) {
      assert.equal(by[id].status, 'blocked', `${id}: ${JSON.stringify(by[id].steps.map((s) => s.error))}`);
      assert.match(by[id].steps[0].error ?? '', /public|http/i);
    }
    assert.equal(by['G-4'].status, 'passed', 'the sample site is still allowed');
  });
});

describe('a server other people use', () => {
  const boot = async (options: Parameters<typeof createApp>[0]) => {
    const { server, runs } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'hard-')), accounts: true, allowSignup: true, ...options });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = '';
    const call = async (path: string, init: { method?: string; json?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
      const res = await fetch(base + path, {
        method: init.method ?? (init.json !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
        headers: { ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...init.headers },
        body: init.raw ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      });
      const set = res.headers.get('set-cookie')?.split(';')[0];
      if (set && !set.endsWith('=')) cookie = set;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, headers: res.headers };
    };
    return { server, runs, call };
  };

  it('counts sign-ups per visitor, not per proxy, when it sits behind one', async () => {
    const { server, call } = await boot({ trustProxy: true });
    try {
      await call('/api/auth/setup', { json: { email: 'a@x.io', name: 'A', password: 'admin-password' } });
      for (let i = 0; i < 8; i++) {
        const r = await call('/api/auth/register', { json: { email: `f${i}@x.io`, name: 'F', password: 'friend-password-1' }, headers: { 'x-real-ip': `203.0.113.${i + 1}` } });
        assert.equal(r.status, 200, `friend ${i}`);
      }
      for (let i = 0; i < 5; i++) await call('/api/auth/register', { json: { email: `s${i}@x.io`, name: 'S', password: 'spam-password-1' }, headers: { 'x-real-ip': '198.51.100.9' } });
      assert.equal((await call('/api/auth/register', { json: { email: 's9@x.io', name: 'S', password: 'spam-password-1' }, headers: { 'x-real-ip': '198.51.100.9' } })).status, 429, 'one visitor is still limited');
    } finally { server.close(); }
  });

  it('does not believe address headers when it is not behind a proxy', async () => {
    const { server, call } = await boot({});
    try {
      await call('/api/auth/setup', { json: { email: 'a@x.io', name: 'A', password: 'admin-password' } });
      for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/register', { json: { email: `f${i}@x.io`, name: 'F', password: 'friend-password-1' }, headers: { 'x-real-ip': `203.0.113.${i + 1}` } })).status, 200);
      assert.equal((await call('/api/auth/register', { json: { email: 'f9@x.io', name: 'F', password: 'friend-password-1' }, headers: { 'x-real-ip': '203.0.113.99' } })).status, 429, 'a made-up header does not give a fresh allowance');
    } finally { server.close(); }
  });

  it('answers a bad request with a clear error, not a server error', async () => {
    const { server, call } = await boot({});
    try {
      await call('/api/auth/setup', { json: { email: 'a@x.io', name: 'A', password: 'admin-password' } });
      assert.equal((await call('/api/auth/login', { raw: '{not json', headers: { 'content-type': 'application/json' } })).status, 400);
      assert.equal((await call('/api/auth/login', { json: { email: 'a@x.io', password: 'admin-password' }, headers: { origin: 'null' } })).status, 403, 'a "null" origin is refused');
      const page = await call('/api/auth/state');
      assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
    } finally { server.close(); }
  });

  it('keeps one person from filling the queue, and from testing private addresses', async () => {
    const { server, call } = await boot({ maxPerUser: 1, maxConcurrent: 1, blockPrivateTargets: true });
    try {
      await call('/api/auth/setup', { json: { email: 'a@x.io', name: 'A', password: 'admin-password' } });
      const made = await call('/api/usecases/generate', { json: { title: 'Sample', text: DEMO_USE_CASE, appUrl: 'http://example.com' } });
      assert.equal(made.status, 201);
      const id = made.body.suite.id;
      const toMetadata = await call(`/api/suites/${id}/run`, { json: { appUrl: 'http://169.254.169.254/' } });
      assert.equal(toMetadata.status, 400);
      assert.match(toMetadata.body.error, /public/);
      assert.equal((await call(`/api/suites/${id}/run`, { json: { appUrl: 'file:///etc/passwd' } })).status, 400);

      const first = await call('/api/demo?version=1', { method: 'POST' });
      assert.equal(first.status, 202);
      const second = await call('/api/demo?version=1', { method: 'POST' });
      assert.equal(second.status, 429, 'a second run while one is waiting or running');
      assert.match(second.body.error, /already have/);
      await call('/api/runs/' + first.body.id, { method: 'DELETE' });
    } finally { server.close(); }
  });
});

describe('old runs', () => {
  it('are deleted after the keep period, and recent or unfinished ones are not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prune-'));
    const old = (id: string, status: string, finishedAt: string) => {
      mkdirSync(join(dir, 'runs', id), { recursive: true });
      writeFileSync(join(dir, 'runs', id, 'run.json'), JSON.stringify({ id, name: 'x', framework: 'custom', appUrl: 'http://x', command: '', install: false, status, createdAt: finishedAt, finishedAt, project: 'p' }));
    };
    old('aaaaaaaaaaaa', 'passed', '2020-01-01T00:00:00.000Z');
    old('bbbbbbbbbbbb', 'passed', new Date().toISOString());
    old('cccccccccccc', 'running', '2020-01-01T00:00:00.000Z'); // a restart marks this as error and finished now
    new RunManager({ dataDir: dir, keepDays: 30 });
    assert.equal(existsSync(join(dir, 'runs', 'aaaaaaaaaaaa')), false);
    assert.equal(existsSync(join(dir, 'runs', 'bbbbbbbbbbbb')), true);
    assert.equal(existsSync(join(dir, 'runs', 'cccccccccccc')), true);
  });
});
