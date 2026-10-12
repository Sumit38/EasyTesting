import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { createApp } from '../src/server/index.js';

describe('accounts', () => {
  let web: Server;
  let base = '';
  before(async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'auth-')), accounts: true, timeoutMs: 30_000 });
    web = server;
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  after(() => web.close());

  /** A tiny client that keeps its own cookie, like a browser tab. */
  const client = () => {
    let cookie = '';
    return {
      async call(path: string, init: RequestInit & { json?: unknown } = {}) {
        const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
        if (cookie) headers.cookie = cookie;
        if (init.json !== undefined) {
          headers['content-type'] = 'application/json';
          init.body = JSON.stringify(init.json);
        }
        const res = await fetch(base + path, { ...init, headers });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        return { status: res.status, body: (await res.json().catch(() => ({}))) as any, res };
      },
    };
  };

  const admin = client();
  const ann = client();
  const bob = client();

  it('asks for the first account, and that account becomes the admin', async () => {
    const state = await admin.call('/api/auth/state');
    assert.equal(state.body.setup, true);
    assert.equal(state.body.user, null);
    const weak = await admin.call('/api/auth/setup', { method: 'POST', json: { email: 'root@x.io', password: 'short' } });
    assert.equal(weak.status, 400);
    const ok = await admin.call('/api/auth/setup', { method: 'POST', json: { email: 'root@x.io', name: 'Root', password: 'correct horse' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.role, 'admin');
    assert.match(ok.res.headers.get('set-cookie') ?? '', /HttpOnly.*SameSite=Strict/);
    assert.equal((await admin.call('/api/auth/setup', { method: 'POST', json: { email: 'b@x.io', password: 'another pass' } })).status, 403, 'setup works once');
  });

  it('blocks everything until you sign in', async () => {
    assert.equal((await client().call('/api/runs')).status, 401);
    const bad = await client().call('/api/auth/login', { method: 'POST', json: { email: 'root@x.io', password: 'wrong password' } });
    assert.equal(bad.status, 401);
  });

  it('only an admin adds users; duplicates and weak passwords are refused', async () => {
    assert.equal((await admin.call('/api/users', { method: 'POST', json: { email: 'ann@x.io', name: 'Ann', password: 'ann-password' } })).status, 201);
    assert.equal((await admin.call('/api/users', { method: 'POST', json: { email: 'bob@x.io', name: 'Bob', password: 'bob-password' } })).status, 201);
    assert.equal((await admin.call('/api/users', { method: 'POST', json: { email: 'ANN@x.io', password: 'ann-password' } })).status, 409);
    assert.equal((await admin.call('/api/users', { method: 'POST', json: { email: 'z@x.io', password: '123' } })).status, 400);
    assert.equal((await ann.call('/api/auth/login', { method: 'POST', json: { email: 'ann@x.io', password: 'ann-password' } })).status, 200);
    assert.equal((await bob.call('/api/auth/login', { method: 'POST', json: { email: 'bob@x.io', password: 'bob-password' } })).status, 200);
    assert.equal((await ann.call('/api/users')).status, 403, 'a tester cannot list users');
    assert.equal((await ann.call('/api/users', { method: 'POST', json: { email: 'c@x.io', password: 'whatever123' } })).status, 403);
  });

  it('each tester sees only their own runs; the admin sees all', async () => {
    const zip = zipSync({ 'a.mjs': strToU8('console.log(1)') });
    const q = new URLSearchParams({ name: 'Ann project', framework: 'custom', filename: 'p.zip', install: '0', command: 'node a.mjs' });
    const made = await ann.call('/api/runs?' + q, { method: 'POST', body: zip });
    assert.equal(made.status, 202);
    const id = made.body.id as string;
    assert.match(made.body.project, /^u\d+-ann-project$/, 'projects are namespaced by owner');

    assert.equal((await ann.call('/api/runs')).body.length, 1);
    assert.equal((await bob.call('/api/runs')).body.length, 0);
    assert.equal((await bob.call('/api/runs/' + id)).status, 404, 'Bob cannot open Ann’s run');
    assert.equal((await bob.call(`/api/runs/${id}/report`)).status, 404);
    assert.equal((await bob.call('/api/runs/' + id, { method: 'DELETE' })).status, 404);
    assert.equal((await admin.call('/api/runs')).body.length, 1);
    assert.equal((await admin.call('/api/runs/' + id)).status, 200);
  });

  it('refuses a state-changing request that names another site as its origin', async () => {
    const res = await ann.call('/api/auth/logout', { method: 'POST', headers: { origin: 'https://evil.example' } });
    // logout is public, so use a protected write instead
    const protectedWrite = await ann.call('/api/runs/aaaaaaaaaaaa/stop', { method: 'POST', headers: { origin: 'https://evil.example' } });
    assert.equal(protectedWrite.status, 403);
    assert.equal(res.status, 403);
    assert.equal((await ann.call('/api/runs')).status, 200, 'the forged logout did not sign Ann out');
  });

  it('a disabled user is signed out and cannot sign in; the last admin cannot be removed', async () => {
    const users = (await admin.call('/api/users')).body as { id: number; email: string }[];
    const bobId = users.find((u) => u.email === 'bob@x.io')!.id;
    assert.equal((await admin.call('/api/users/' + bobId, { method: 'PATCH', json: { disabled: true } })).status, 200);
    assert.equal((await bob.call('/api/runs')).status, 401, 'existing session ended');
    assert.equal((await client().call('/api/auth/login', { method: 'POST', json: { email: 'bob@x.io', password: 'bob-password' } })).status, 401);
    const rootId = users.find((u) => u.email === 'root@x.io')!.id;
    assert.equal((await admin.call('/api/users/' + rootId, { method: 'PATCH', json: { role: 'tester' } })).status, 409);
  });

  it('locks sign-in for a minute after repeated failures', async () => {
    const c = client();
    for (let i = 0; i < 5; i++) await c.call('/api/auth/login', { method: 'POST', json: { email: 'ann@x.io', password: 'nope-nope-' + i } });
    const locked = await c.call('/api/auth/login', { method: 'POST', json: { email: 'ann@x.io', password: 'ann-password' } });
    assert.equal(locked.status, 429);
  });
});

describe('self-service sign-up', () => {
  const boot = async (allowSignup: boolean) => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'signup-')), accounts: true, allowSignup });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (path: string, json?: unknown) => {
      const res = await fetch(base + path, { method: json === undefined ? 'GET' : 'POST', headers: json === undefined ? {} : { 'content-type': 'application/json' }, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
    };
    return { server, call };
  };

  it('is off unless the server turns it on', async () => {
    const { server, call } = await boot(false);
    try {
      assert.equal((await call('/api/auth/state')).body.signup, false);
      await call('/api/auth/setup', { email: 'a@x.io', name: 'A', password: 'admin-password' });
      const r = await call('/api/auth/register', { email: 'new@x.io', name: 'N', password: 'new-password-1' });
      assert.equal(r.status, 403);
    } finally { server.close(); }
  });

  it('lets a new person create a tester account and signs them in, never as an admin', async () => {
    const { server, call } = await boot(true);
    try {
      assert.equal((await call('/api/auth/state')).body.signup, true);
      assert.equal((await call('/api/auth/register', { email: 'early@x.io', name: 'E', password: 'early-password' })).status, 409, 'the first account must be the admin');
      await call('/api/auth/setup', { email: 'a@x.io', name: 'A', password: 'admin-password' });
      const r = await call('/api/auth/register', { email: 'new@x.io', name: 'New Person', password: 'new-password-1', role: 'admin' });
      assert.equal(r.status, 200);
      assert.equal(r.body.user.role, 'tester', 'asking to be an admin is ignored');
      assert.ok(r.cookie.startsWith('nh_session='));
      assert.equal((await call('/api/auth/register', { email: 'NEW@x.io', name: 'Dup', password: 'new-password-2' })).status, 409);
      assert.equal((await call('/api/auth/register', { email: 'weak@x.io', name: 'W', password: 'short' })).status, 400);
      const login = await call('/api/auth/login', { email: 'new@x.io', password: 'new-password-1' });
      assert.equal(login.status, 200);
    } finally { server.close(); }
  });

  it('limits how many accounts one address can create in an hour', async () => {
    const { server, call } = await boot(true);
    try {
      await call('/api/auth/setup', { email: 'a@x.io', name: 'A', password: 'admin-password' });
      for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/register', { email: `u${i}@x.io`, name: 'U', password: 'user-password-' + i })).status, 200);
      assert.equal((await call('/api/auth/register', { email: 'u6@x.io', name: 'U', password: 'user-password-6' })).status, 429);
    } finally { server.close(); }
  });
});
