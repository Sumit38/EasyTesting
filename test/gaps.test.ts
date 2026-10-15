import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server/index.js';

describe('fixing the gaps in a set of test cases', () => {
  const boot = async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'gaps-')), accounts: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = '';
    const call = async (path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = res.headers.get('set-cookie')?.split(';')[0];
      if (set && !set.endsWith('=')) cookie = set;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    await call('/api/auth/setup', { email: 'a@x.io', name: 'A', password: 'admin-password' });
    const upload = async (csv: string) => (await fetch(base + '/api/imports?filename=c.csv', { method: 'POST', headers: { cookie }, body: csv })).json() as Promise<any>;
    return { server, call, upload };
  };
  const useCase = '# Professional Use Case Document\n| Field | Details |\n|---|---|\n| Primary Actor | Customer |\n## 4. Main Flow\n1. The customer opens the shop.\n2. The customer logs in with email and password.\n3. The customer adds the product to the cart.\n4. The system displays "Added to cart".';

  it('says when a step only lacks its value, so the screen can ask for just that', async () => {
    const { server, call } = await boot();
    try {
      const r = await call('/api/steps/interpret', { steps: ['Enter valid password', 'Click the "Pay" button'] });
      assert.deepEqual(r.body.steps.map((s: any) => [s.action, s.target, s.needsValue]), [['type', 'Password', true], ['click', 'Pay', false]]);
    } finally { server.close(); }
  });

  it('rebuilds a generated set from its use case, replacing steps that were edited into nonsense', async () => {
    const { server, call } = await boot();
    try {
      const made = await call('/api/usecases/generate', { title: 'Shop', text: useCase });
      const id = made.body.suite.id;
      const clean = made.body.suite.cases[0].steps;
      assert.ok(!clean.some((s: string) => /\||Professional|Main Flow/.test(s)), clean.join('\n'));
      await call('/api/suites/' + id, { cases: [{ id: 'TC-001', title: 'x', steps: ['| Field | Details |', 'Main Flow'], expected: '' }] }, 'PUT');
      const rebuilt = await call(`/api/suites/${id}/regenerate`, {});
      assert.equal(rebuilt.status, 200);
      assert.deepEqual(rebuilt.body.suite.cases[0].steps, clean);
      assert.equal((await call('/api/suites/' + id)).body.cases[0].steps.length, clean.length, 'and it is saved');
    } finally { server.close(); }
  });

  it('refuses to rebuild an uploaded set, which has no use case behind it', async () => {
    const { server, call, upload } = await boot();
    try {
      const up = await upload('ID,Title,Steps\nTC-1,Pay,Click the "Pay" button\n');
      const made = await call(`/api/imports/${up.importId}/confirm`, { mapping: up.mapping, hasHeader: true });
      const r = await call(`/api/suites/${made.body.suite.id}/regenerate`, {});
      assert.equal(r.status, 409);
      assert.match(r.body.error, /Fix the gaps/);
    } finally { server.close(); }
  });
});
