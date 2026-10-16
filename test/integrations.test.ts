import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/server/appdb.js';
import type { Bug } from '../src/server/bugs.js';
import { Integrations } from '../src/server/integrations.js';
import { createApp } from '../src/server/index.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE } from '../src/server/demo.js';

/** Stand-ins for Jira Cloud and Azure DevOps Services that answer like the real ones and keep every request. */
function fakeTools() {
  const seen: { method: string; url: string; auth: string; type: string; body: any }[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const send = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init.method ?? 'GET', url: url.toString(), auth: headers.get('authorization') ?? '', type: headers.get('content-type') ?? '', body });
    const p = decodeURIComponent(url.pathname);
    if (url.host === 'acme.atlassian.net') {
      if (headers.get('authorization') !== 'Basic ' + Buffer.from('qa@acme.io:good-token').toString('base64')) return reply(401, { errorMessages: ['Unauthorized'] });
      if (p === '/rest/api/3/myself') return reply(200, { displayName: 'QA Bot' });
      if (p === '/rest/api/3/project/SHOP') return reply(200, { name: 'Shop', issueTypes: [{ name: 'Bug' }, { name: 'Story' }, { name: 'Task' }] });
      if (p === '/rest/api/3/search/jql') return reply(200, { issues: [{ key: 'SHOP-12', fields: { summary: 'Checkout flow', status: { name: 'In Progress' } } }] });
      if (p === '/rest/api/3/issue' && init.method === 'POST') return reply(201, { key: 'SHOP-101' });
      if (p === '/rest/api/3/issueLink') return reply(201, {});
      if (p === '/rest/api/3/issue/SHOP-101') return reply(200, { fields: { status: { name: 'In Review', statusCategory: { key: 'indeterminate' } } } });
      if (p === '/rest/api/3/issue/SHOP-101/comment') return reply(201, {});
    }
    if (url.host === 'dev.azure.com') {
      if (p === '/acme/_apis/projects/Online Shop') return reply(200, { name: 'Online Shop' });
      if (p === '/acme/Online Shop/_apis/wit/workitemtypes') return reply(200, { value: [{ name: 'Bug' }, { name: 'User Story' }] });
      if (p === '/acme/Online Shop/_apis/wit/wiql') return reply(200, { workItems: [{ id: 42 }] });
      if (p === '/acme/_apis/wit/workitems') return reply(200, { value: [{ id: 42, fields: { 'System.Title': 'Checkout flow', 'System.State': 'Active' } }] });
      if (p === '/acme/Online Shop/_apis/wit/workitems/$Bug') return reply(200, { id: 777, fields: { 'System.State': 'New' } });
    }
    return reply(404, { message: 'not found: ' + p });
  }) as typeof fetch;
  return { send, seen };
}

describe('filing bugs in Jira and Azure DevOps', () => {
  it('connects once as an admin, files a bug linked to a user story, follows its status and reports the re-test', async () => {
    const tools = fakeTools();
    const dataDir = mkdtempSync(join(tmpdir(), 'ig-'));
    const { server } = createApp({ dataDir, accounts: true, integrationFetch: tools.send, timeoutMs: 120_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const jar = { admin: '', tester: '' };
    const as = (who: keyof typeof jar) => async (path: string, json?: unknown, method = json === undefined ? 'GET' : 'POST') => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(jar[who] ? { cookie: jar[who] } : {}) }, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = res.headers.get('set-cookie')?.split(';')[0];
      if (set && !set.endsWith('=')) jar[who] = set;
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
    };
    const admin = as('admin'), tester = as('tester');
    try {
      await admin('/api/auth/setup', { email: 'a@x.io', name: 'Admin', password: 'admin-password' });
      const jiraSettings = { site: 'https://acme.atlassian.net/', email: 'qa@acme.io', project: 'shop', token: 'good-token' };

      // A wrong token is refused and nothing is saved.
      const wrong = await admin('/api/integrations/jira', { ...jiraSettings, token: 'bad-token' }, 'PUT');
      assert.equal(wrong.status, 400);
      assert.match(wrong.body.error, /refused the sign-in/);
      assert.equal((await admin('/api/integrations')).body.jira.connected, false);

      // The right one connects; the screens learn the project, never the token, and the database holds it only encrypted.
      const ok = await admin('/api/integrations/jira', jiraSettings, 'PUT');
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.match(ok.body.message, /Connected as QA Bot to project Shop \(SHOP\)/);
      const summary = (await admin('/api/integrations')).body;
      assert.deepEqual(summary.jira, { connected: true, project: 'SHOP', where: 'https://acme.atlassian.net', bugType: 'Bug', storyType: 'Story' });
      assert.ok(!JSON.stringify(summary).includes('good-token'));
      assert.ok(!readFileSync(join(dataDir, 'app.db')).includes('good-token') && !readFileSync(join(dataDir, 'app.db-wal')).includes('good-token'), 'the token is not stored in plain text');

      // Testers use the connection but cannot change it.
      await admin('/api/users', { email: 't@x.io', name: 'Tess', password: 'tester-password', role: 'tester' });
      await tester('/api/auth/login', { email: 't@x.io', password: 'tester-password' });
      assert.equal((await tester('/api/integrations/jira', jiraSettings, 'PUT')).status, 403);

      // A failing test case becomes a bug.
      const made = await tester('/api/usecases/generate', { text: DEMO_USE_CASE, testData: Object.entries(DEMO_TEST_DATA).map(([k, v]) => `${k}=${v}`).join('\n'), method: 'rules' });
      await tester('/api/suites/' + made.body.suite.id, { cases: [{ id: 'TC-001', title: 'Welcome text', steps: ['Open the application', 'Verify "Order history" is displayed'], expected: '' }] }, 'PUT');
      const runOnce = async () => {
        const run = await tester(`/api/suites/${made.body.suite.id}/run`, { appUrl: `${base}/demo/login?v=1` });
        for (let i = 0; i < 240; i++) {
          const r = await tester('/api/runs/' + run.body.id);
          if (!['queued', 'running'].includes(r.body.status)) return run.body.id as string;
          await new Promise((x) => setTimeout(x, 250));
        }
        throw new Error('run did not finish');
      };
      const runId = await runOnce();
      const bug = (await tester(`/api/runs/${runId}/report`)).body.bugs[0];
      assert.ok(bug, 'a bug was found');

      // Find the user story, then file the bug linked to it.
      const stories = (await tester('/api/integrations/jira/stories?q=checkout')).body;
      assert.deepEqual(stories, [{ key: 'SHOP-12', title: 'Checkout flow', status: 'In Progress', url: 'https://acme.atlassian.net/browse/SHOP-12' }]);
      const filed = await tester(`/api/runs/${runId}/tickets`, { bugId: bug.id, tool: 'jira', storyKey: 'SHOP-12' });
      assert.equal(filed.status, 201, JSON.stringify(filed.body));
      assert.equal(filed.body.ticket.key, 'SHOP-101');
      assert.equal(filed.body.ticket.story.key, 'SHOP-12');
      const created = tools.seen.find((r) => r.url.endsWith('/rest/api/3/issue') && r.method === 'POST')!;
      assert.equal(created.body.fields.project.key, 'SHOP');
      assert.equal(created.body.fields.issuetype.name, 'Bug');
      assert.match(created.body.fields.summary, /^\[EasyTesting\] /);
      assert.ok(JSON.stringify(created.body.fields.description).includes('Order history'), 'what went wrong is in the ticket');
      assert.ok(JSON.stringify(created.body.fields.description).includes(`/#/report/${runId}`), 'with a link back to the report');
      const link = tools.seen.find((r) => r.url.endsWith('/rest/api/3/issueLink'))!;
      assert.deepEqual([link.body.inwardIssue.key, link.body.outwardIssue.key], ['SHOP-101', 'SHOP-12']);
      assert.equal((await tester(`/api/runs/${runId}/tickets`, { bugId: bug.id, tool: 'jira' })).status, 409, 'a bug is filed once');

      // Its real status is read from Jira, and not again within a minute.
      const withStatus = (await tester(`/api/runs/${runId}/report`)).body.bugs[0].ticket;
      assert.deepEqual([withStatus.status.name, withStatus.status.category], ['In Review', 'doing']);
      assert.equal((await tester(`/api/runs/${runId}/tickets/refresh`, {})).body.checked, 0);

      // Marked fixed, re-tested, still failing: the ticket gets a comment saying so.
      await tester(`/api/runs/${runId}/bugs/${bug.id}`, { status: 'fixed' }, 'PATCH');
      await runOnce();
      for (let i = 0; i < 40 && !tools.seen.some((r) => r.url.endsWith('/SHOP-101/comment')); i++) await new Promise((x) => setTimeout(x, 100));
      const comment = tools.seen.find((r) => r.url.endsWith('/SHOP-101/comment'));
      assert.ok(comment, 'the re-test was reported on the ticket');
      assert.match(JSON.stringify(comment!.body), /still fails, so the bug is reopened/);
    } finally {
      server.close();
    }
  });

  it('files in Azure DevOps as a child of the chosen user story', async () => {
    const tools = fakeTools();
    const dir = mkdtempSync(join(tmpdir(), 'ig-ado-'));
    const ig = new Integrations(new AppDb(join(dir, 'app.db')).db, dir, tools.send);
    const { config, token } = ig.clean('ado', { org: 'https://dev.azure.com/acme', project: 'Online Shop', token: 'pat-123' });
    assert.match(await ig.test('ado', config, token), /Connected to project Online Shop/);
    ig.save('ado', config, token);
    const [story] = await ig.stories('ado', 'checkout');
    assert.deepEqual(story, { key: '42', title: 'Checkout flow', status: 'Active', url: 'https://dev.azure.com/acme/Online%20Shop/_workitems/edit/42' });
    const bug: Bug = { id: 'BUG-001', key: 'k', title: 'TC-1 Pay: The text "Paid" is not on the page', test: 'TC-1 Pay', severity: 'high', status: 'open', cause: 'assertion', error: 'The text "Paid" is not on the page.', firstRun: 'r1', lastRun: 'r1', occurrences: 1, history: [] };
    const ticket = await ig.createTicket('ado', bug, { story });
    assert.equal(ticket.key, '777');
    const sent = tools.seen.find((r) => r.url.includes('/_apis/wit/workitems/$Bug'))!;
    assert.equal(sent.type, 'application/json-patch+json');
    assert.equal(sent.auth, 'Basic ' + Buffer.from(':pat-123').toString('base64'));
    assert.ok(sent.body.some((op: any) => op.path === '/fields/Microsoft.VSTS.TCM.ReproSteps' && op.value.includes('&quot;Paid&quot;')), 'the details go in Repro Steps, as safe HTML');
    assert.ok(sent.body.some((op: any) => op.path === '/relations/-' && op.value.rel === 'System.LinkTypes.Hierarchy-Reverse' && op.value.url.endsWith('/_apis/wit/workItems/42')), 'linked as a child of story 42');
  });

  it('checks the settings before they are saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ig-c-'));
    const ig = new Integrations(new AppDb(join(dir, 'app.db')).db, dir, fakeTools().send);
    assert.throws(() => ig.clean('jira', { site: 'http://acme.atlassian.net', email: 'a@b.c', project: 'SHOP', token: 't' }), /atlassian\.net/);
    assert.throws(() => ig.clean('jira', { site: 'https://evil.example.com', email: 'a@b.c', project: 'SHOP', token: 't' }), /atlassian\.net/);
    assert.throws(() => ig.clean('ado', { org: 'https://dev.azure.com/acme', project: 'P', token: '' }), /personal access token/);
    assert.throws(() => ig.clean('ado', { org: 'https://intranet.local/tfs', project: 'P', token: 't' }), /dev\.azure\.com/);
  });
});
