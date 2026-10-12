import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { BASE_SAVE, page as app } from '../demo/app.js';
import { createApp } from '../src/server/index.js';
import { launchOptions } from './launch.js';

const root = resolve('.');

// The uploaded project: an ordinary Playwright script with no healing code in it.
const spec = `
import { chromium } from 'playwright-core';
const browser = await chromium.launch(${JSON.stringify(launchOptions)});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
try {
  await page.goto(process.env.APP_URL);
  await page.locator('#saveBtn').click({ timeout: 3000 });
} finally {
  await browser.close();
}
`;

describe('web app', () => {
  let site: Server, web: Server;
  let version = 'v1';
  let base = '';
  let appUrl = '';

  before(async () => {
    site = createServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(app(version === 'v2' ? BASE_SAVE.replace('saveBtn', 'coloredButton') : undefined));
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    appUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;

    // Data dir inside the repo so the uploaded script can resolve playwright-core from node_modules.
    const { server } = createApp({ dataDir: mkdtempSync(join(root, '.tmp-srv-')), timeoutMs: 60_000, token: 's3cret' });
    web = server;
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  after(() => {
    site.close();
    web.close();
  });

  const auth = { Authorization: 'Bearer s3cret' };
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

  const upload = async (name: string) => {
    const zip = zipSync({ 'suite/save.test.mjs': strToU8(spec) }); // a single top-level folder, as zips usually have
    const q = new URLSearchParams({
      name,
      framework: 'custom',
      appUrl,
      install: '0',
      filename: 'suite.zip',
    });
    const res = await call('/api/runs?' + q, { method: 'POST', body: zip });
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < 120; i++) {
      const run = (await (await call('/api/runs/' + id)).json()) as any;
      if (!['queued', 'installing', 'running'].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('run did not finish');
  };

  it('rejects requests without the token', async () => {
    assert.equal((await fetch(base + '/api/runs')).status, 401);
  });

  it('serves the UI', async () => {
    const res = await fetch(base + '/');
    assert.match(await res.text(), /EasyTesting/);
  });

  it('refuses a zip that tries to write outside the project', async () => {
    const raw = zipSync({ '../evil.txt': strToU8('x') });
    const q = new URLSearchParams({ name: 'evil', framework: 'custom', filename: 'x.zip', install: '0', command: 'node -v' });
    const res = await call('/api/runs?' + q, { method: 'POST', body: raw });
    const { id } = (await res.json()) as { id: string };
    const run = (await (await call('/api/runs/' + id)).json()) as any;
    assert.equal(run.status, 'error');
    assert.match(await (await call(`/api/runs/${id}/log`)).text(), /unsafe path/);
  });

  it('learns on a green run, heals after the UI changes, applies on approval and serves the patched project', async () => {
    version = 'v1';
    const green = await upload('Profile suite');
    assert.equal(green.status, 'passed', await (await call(`/api/runs/${green.id}/log`)).text());
    assert.equal(green.heals.length, 0);

    version = 'v2';
    const broken = await upload('Profile suite'); // same project name: reuses the fingerprints
    assert.equal(broken.status, 'passed', await (await call(`/api/runs/${broken.id}/log`)).text());
    assert.equal(broken.heals.length, 1);
    const heal = broken.heals[0];
    assert.equal(heal.oldSelector, '#saveBtn');
    assert.equal(heal.status, 'verified');
    assert.match(heal.file, /save\.test\.mjs$/);

    const applied = (await (await call(`/api/runs/${broken.id}/apply`, { method: 'POST', body: '{}' })).json()) as any;
    assert.equal(applied.applied.length, 1);

    const files = unzipSync(new Uint8Array(await (await call(`/api/runs/${broken.id}/download`)).arrayBuffer()));
    const patched = Buffer.from(files['save.test.mjs'] ?? []).toString();
    assert.ok(patched.includes('role=button[name=\\"Save\\"s]'), patched);
    assert.ok(!patched.includes("'#saveBtn'"));
  });
});
