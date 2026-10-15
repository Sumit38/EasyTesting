import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadRecords } from '../src/apply.js';
import { generateCases } from '../src/cases/generate.js';
import type { TestCase } from '../src/cases/model.js';
import { runCases, type CaseResult } from '../src/exec/runner.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE, demoPage } from '../src/server/demo.js';

describe('running plain-English test cases', () => {
  let site: Server;
  let origin = '';
  before(async () => {
    site = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const page = demoPage(u.pathname, u.searchParams.get('v') ?? '1');
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      res.end(page ?? 'not found');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  const cases = generateCases(DEMO_USE_CASE, { testData: DEMO_TEST_DATA }).cases;
  const dir = mkdtempSync(join(tmpdir(), 'exec-'));
  const store = join(dir, 'fp.db');
  const summary = (rs: CaseResult[]) => rs.map((r) => `${r.id} ${r.status} ${r.title}${r.status === 'failed' ? ' :: ' + r.steps.find((s) => s.status === 'failed')?.text + ' -> ' + r.steps.find((s) => s.status === 'failed')?.error : ''}`).join('\n');

  it('runs every generated case on the healthy site, and the checks mean something', async () => {
    const { results } = await runCases({ cases, appUrl: `${origin}/demo/login?v=1`, healDir: join(dir, 'h1'), storeFile: store, stepTimeout: 4000 });
    assert.ok(results.length >= 8, `cases: ${results.length}`);
    assert.deepEqual(results.filter((r) => r.status !== 'passed').map((r) => r.id), [], '\n' + summary(results));
    const happy = results.find((r) => /main flow/.test(r.title))!;
    assert.ok(happy.steps.every((s) => s.confidence > 0.6), JSON.stringify(happy.steps.map((s) => [s.text, s.confidence])));
    assert.ok(happy.confidence >= 85, 'a clean case is reported with high confidence: ' + happy.confidence);
    assert.ok(happy.understanding >= 90);
    const written = JSON.parse(readFileSync(join(dir, 'h1', 'results.json'), 'utf8'));
    assert.equal(written.tests.length, results.length);
    assert.ok(readdirSync(join(dir, 'h1', 'coverage')).length > 0, 'coverage was recorded');
  });

  it('fails a case when the app really misbehaves, and says so', async () => {
    const wrong: TestCase[] = [{ id: 'X-1', title: 'Wrong message expected', steps: ['Open the application', 'Enter "nobody@example.com" in the Email field', 'Enter "Password1!" in the Password field', 'Click the "Sign in" button', 'Verify "Welcome back" is displayed'], expected: '' }];
    const { results, passed } = await runCases({ cases: wrong, appUrl: `${origin}/demo/login?v=1`, healDir: join(dir, 'h2'), storeFile: join(dir, 'other.db'), stepTimeout: 2500 });
    assert.equal(passed, false);
    const failed = results[0].steps.find((s) => s.status === 'failed')!;
    assert.equal(failed.index, 4);
    assert.match(failed.error ?? '', /not on the page/);
    assert.match(results[0].advice ?? '', /real defect/);
    assert.ok(failed.screenshot, 'a screenshot of the failing page was saved');
    assert.equal(results[0].steps.length, 5);
  });

  it('stops a case at a step it cannot read and does not guess', async () => {
    const odd: TestCase[] = [{ id: 'X-2', title: 'Unreadable', steps: ['Open the application', 'Do the needful', 'Click the "Sign in" button'], expected: '' }];
    const { results } = await runCases({ cases: odd, appUrl: `${origin}/demo/login?v=1`, healDir: join(dir, 'h3'), storeFile: join(dir, 'other2.db'), stepTimeout: 2000 });
    assert.deepEqual(results[0].steps.map((s) => s.status), ['passed', 'failed', 'skipped']);
    assert.match(results[0].advice ?? '', /could not be read/);
  });

  it('still passes after the page renames its controls and relabels the button, healing as it goes', async () => {
    const { results } = await runCases({ cases, appUrl: `${origin}/demo/login?v=2`, healDir: join(dir, 'h4'), storeFile: store, stepTimeout: 4000 });
    assert.deepEqual(results.filter((r) => r.status !== 'passed').map((r) => r.id), [], '\n' + summary(results));
    const records = loadRecords(join(dir, 'h4'));
    assert.ok(records.length > 0, 'locator changes were recorded as heals');
    assert.ok(records.every((r) => r.status === 'verified'), JSON.stringify(records.map((r) => [r.oldSelector, r.newSelector, r.status])));
    const healed = results.flatMap((r) => r.steps).filter((s) => s.via === 'healed');
    assert.ok(healed.length > 0);
    assert.ok(healed.every((s) => s.notes.some((n) => /stopped matching/.test(n))));
  });

  it('refuses to guess when a button is renamed beyond recognition, and lists what is on the page', async () => {
    const one = cases.filter((c) => /main flow/.test(c.title));
    const { results } = await runCases({ cases: one, appUrl: `${origin}/demo/login?v=3`, healDir: join(dir, 'h6'), storeFile: store, stepTimeout: 2500 });
    const bad = results[0].steps.find((s) => s.status === 'failed')!;
    assert.equal(results[0].status, 'failed');
    assert.match(bad.error ?? '', /Could not find "Sign in" \(button\)/);
    assert.match(bad.error ?? '', /"Log in"/, 'the button that is there is named, so the step can be reworded');
    assert.match(results[0].advice ?? '', /page changed or the step names it differently/);
  });

  it('counts a field that is only marked invalid as an error, and checks that text is absent', async () => {
    const flagged: TestCase[] = [
      { id: 'F-1', title: 'Field flagged, no message', expected: '', steps: ['Open the application', 'Enter "x" in the E field', 'Click the "Check" button', 'Verify an error message is displayed', 'Verify "Never on this page" is not displayed'] },
      { id: 'F-2', title: 'Absent-text check can fail', expected: '', steps: ['Open the application', 'Verify "Flagged page" is not displayed'] },
      { id: 'F-3', title: 'No error expected, but one is flagged', expected: '', steps: ['Open the application', 'Enter "x" in the E field', 'Click the "Check" button', 'Verify no error message is shown'] },
    ];
    const { results } = await runCases({ cases: flagged, appUrl: `${origin}/demo/flagged`, healDir: join(dir, 'h7'), storeFile: join(dir, 'f.db'), stepTimeout: 2500 });
    assert.equal(results[0].status, 'passed', summary(results));
    const verifyStep = results[0].steps[3];
    assert.match(verifyStep.matchedAs ?? '', /marked invalid/);
    assert.ok(verifyStep.confidence < 0.75, 'a flagged field is a weaker signal than a message: ' + verifyStep.confidence);
    assert.equal(results[1].status, 'failed');
    assert.match(results[1].steps[1].error ?? '', /is on the page, but it should not be/);
    assert.equal(results[2].status, 'failed');
    assert.match(results[2].steps[3].error ?? '', /marked as invalid/);
  });

  it('calls a page that will not load blocked, not failed, and does not blame the app', async () => {
    const down: TestCase[] = [{ id: 'N-1', title: 'Site down', expected: '', steps: ['Open the application', 'Click the "Sign in" button'] }];
    const { results, passed } = await runCases({ cases: down, appUrl: 'http://127.0.0.1:9/', healDir: join(dir, 'h8'), storeFile: join(dir, 'n.db'), stepTimeout: 1500 });
    assert.equal(results[0].status, 'blocked');
    assert.equal(results[0].steps[0].environment, true);
    assert.equal(passed, false);
    assert.match(results[0].advice ?? '', /could not load the page/);
    const written = JSON.parse(readFileSync(join(dir, 'h8', 'results.json'), 'utf8'));
    assert.equal(written.tests[0].status, 'interrupted', 'the report shows it as not finished, so no bug is raised');
  });

  it('after a heal, the next run on the changed page uses the new locators and heals nothing', async () => {
    const { results } = await runCases({ cases, appUrl: `${origin}/demo/login?v=2`, healDir: join(dir, 'h5'), storeFile: store, stepTimeout: 4000 });
    assert.deepEqual(results.filter((r) => r.status !== 'passed').map((r) => r.id), [], '\n' + summary(results));
    assert.equal(loadRecords(join(dir, 'h5')).length, 0, 'nothing left to heal');
  });

  it('shows its progress while it runs: every case and step from the start, then each one as it finishes', async () => {
    const heal = join(dir, 'h9');
    const seen: { statuses: string[]; running: boolean }[] = [];
    const peek = () => {
      try {
        const now = JSON.parse(readFileSync(join(heal, 'steps.json'), 'utf8'));
        seen.push({ statuses: now.cases.map((c: CaseResult) => c.status), running: !!now.running });
      } catch { /* not written yet */ }
    };
    const two = cases.slice(0, 2);
    const { results } = await runCases({ cases: two, appUrl: `${origin}/demo/login?v=1`, healDir: heal, storeFile: join(dir, 'p.db'), stepTimeout: 4000, log: (l) => (l.startsWith('\n▶') ? peek() : undefined) });
    assert.deepEqual(seen[0], { statuses: ['pending', 'pending'], running: true }, 'before the first case, both are listed as waiting');
    assert.deepEqual(seen[1], { statuses: ['passed', 'pending'], running: true }, 'when the second starts, the first is already shown as passed');
    const end = JSON.parse(readFileSync(join(heal, 'steps.json'), 'utf8'));
    assert.equal(end.running, undefined, 'the finished file is not marked as running');
    assert.equal(end.live, 'live.png', 'the last picture of the page is kept');
    assert.ok(existsSync(join(heal, 'shots', 'live.png')));
    assert.deepEqual(end.cases.map((c: CaseResult) => c.status), results.map((r) => r.status));
  });
});
