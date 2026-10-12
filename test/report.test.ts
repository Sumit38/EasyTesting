import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppDb } from '../src/server/appdb.js';
import { BugTracker } from '../src/server/bugs.js';
import { buildReport } from '../src/server/report.js';
import { createApp } from '../src/server/index.js';
import { matches, parseScenarios } from '../src/server/scenarios.js';

describe('scenarios', () => {
  it('reads a CSV with a header, quotes and any column order', () => {
    const s = parseScenarios('Priority,Scenario,ID\r\nHigh,"Log in, then out",TC-9\r\nLow,Browse,TC-10\r\n');
    assert.deepEqual(s.map((x) => [x.id, x.title, x.priority]), [['TC-9', 'Log in, then out', 'High'], ['TC-10', 'Browse', 'Low']]);
  });
  it('reads a plain list of titles', () => {
    assert.deepEqual(parseScenarios('Sign up\nSign in\n').map((x) => x.title), ['Sign up', 'Sign in']);
  });
  it('matches tests by id or by title, but not TC-1 against TC-10', () => {
    const [one] = parseScenarios('id,title\nTC-1,Update email address');
    assert.ok(matches(one, 'TC-1 anything'));
    assert.ok(matches(one, 'Update email address works'));
    assert.ok(!matches(one, 'TC-10 something else'));
  });
});

describe('bug lifecycle', () => {
  const tracker = () => new BugTracker(new AppDb(':memory:').db, 'p');
  const failing = { title: 'TC-2 reject bad email', file: 'a.spec.js', status: 'failed', errorLine: 'expect(locator).toHaveText failed' };
  const passing = { ...failing, status: 'passed', errorLine: undefined };
  const sev = () => ({ severity: 'high' as const });

  it('opens a bug, verifies it when a later run passes, and reopens it if it fails again', () => {
    const t = tracker();
    let [bug] = t.reconcile('r1', [failing], sev);
    assert.equal(bug.id, 'BUG-001');
    assert.equal(bug.status, 'open');
    assert.equal(bug.cause, 'assertion');

    [bug] = t.reconcile('r2', [failing], sev);
    assert.equal(bug.status, 'open');
    assert.equal(bug.occurrences, 2);
    assert.equal(t.list().length, 1, 'the same failing test is one bug');

    t.update('BUG-001', { status: 'fixed' });
    [bug] = t.reconcile('r3', [failing], sev);
    assert.equal(bug.status, 'reopened', 'a failed re-test reopens it');
    assert.equal(bug.retest?.result, 'failed');

    t.update('BUG-001', { status: 'fixed' });
    [bug] = t.reconcile('r4', [passing], sev);
    assert.equal(bug.status, 'verified');
    assert.equal(bug.retest?.result, 'passed');

    [bug] = t.reconcile('r5', [failing], sev);
    assert.equal(bug.status, 'reopened', 'a regression reopens a verified bug');
  });

  it('keeps a bug closed as not-a-bug closed', () => {
    const t = tracker();
    t.reconcile('r1', [failing], sev);
    t.update('BUG-001', { status: 'not-a-bug' });
    const [bug] = t.reconcile('r2', [failing], sev);
    assert.equal(bug.status, 'not-a-bug');
  });
});

describe('failed guesses', () => {
  it('are not bugs, and do not count as failing tests in the risk score', () => {
    const t = new BugTracker(new AppDb(':memory:').db, 'p');
    const tests = [
      { title: 'TC-1 real', status: 'passed' as const },
      { title: 'TC-2 guess', status: 'failed' as const, assumed: true, errorLine: 'No error message appeared', file: 'test-cases' },
      { title: 'TC-3 real failure', status: 'failed' as const, errorLine: 'The text is not on the page', file: 'test-cases' },
    ];
    const bugs = t.reconcile('r', tests, () => ({}));
    assert.deepEqual(bugs.map((b) => b.test), ['TC-3 real failure'], 'only the confirmed failure becomes a bug');
    const r = buildReport({ runId: 'r', tests, coverage: [], scenarios: [], bugs, heals: [] });
    assert.equal(r.summary.failed, 2);
    assert.equal(r.summary.assumedFailed, 1);
    const failing = r.risk.parts.find((p) => p.label === 'Failing tests')!;
    assert.match(failing.detail, /1 of 3 executed tests failed \(1 more failed on an assumed expectation/);
    assert.equal(r.density.found, 1);
  });
});

describe('report maths', () => {
  const base = { runId: 'r', coverage: [], scenarios: [], bugs: [], heals: [] };
  it('has low risk when everything passes and nothing is left open', () => {
    const r = buildReport({ ...base, tests: [{ title: 'a', status: 'passed' }, { title: 'b', status: 'passed' }] });
    assert.equal(r.summary.passRate, 100);
    assert.equal(r.risk.level, 'low');
    assert.equal(r.density.perHundredTests, 0);
  });
  it('counts defect density per 100 executed tests and marks unattended scenarios', () => {
    const t = new BugTracker(new AppDb(':memory:').db, 'p');
    const tests = [
      { title: 'TC-1 a', status: 'passed' as const }, { title: 'TC-2 b', status: 'failed' as const, errorLine: 'expect failed', file: 'f' },
      { title: 'TC-3 c', status: 'skipped' as const }, { title: 'TC-4 d', status: 'passed' as const },
    ];
    const bugs = t.reconcile('r', tests, () => ({ severity: 'critical' as const }));
    const r = buildReport({ ...base, tests, bugs, scenarios: parseScenarios('id,title\nTC-1,a\nTC-2,b\nTC-3,c\nTC-5,never automated') });
    assert.equal(r.summary.executed, 3);
    assert.equal(r.density.perHundredTests, 33.3);
    assert.deepEqual(r.scenarios.unattended.map((s) => [s.id, s.status]), [['TC-3', 'skipped'], ['TC-5', 'no-test']]);
    assert.ok(r.risk.score > 25, 'a critical open bug plus gaps is not low risk: ' + r.risk.score);
  });
});

describe('the report for the demo, across a release and a fix', () => {
  let web: import('node:http').Server;
  let base = '';
  const call = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).json() as Promise<any>;
  before(async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'rep-')), timeoutMs: 120_000 });
    web = server;
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });
  after(() => web.close());

  const demo = async (version: string) => {
    const run = await call(`/api/demo?version=${version}`, { method: 'POST' });
    for (let i = 0; i < 180; i++) {
      const r = await call('/api/runs/' + run.id);
      if (!['queued', 'installing', 'running'].includes(r.status)) {
        await new Promise((x) => setTimeout(x, 500)); // the bug list is updated just after the log closes
        return run.id as string;
      }
      await new Promise((x) => setTimeout(x, 500));
    }
    throw new Error('demo run did not finish');
  };

  it('reports results, coverage, unattended scenarios, a bug, then verifies it after the fix', async () => {
    const r1 = await demo('1');
    const healthy = await call(`/api/runs/${r1}/report`);
    assert.equal(healthy.summary.failed, 0, JSON.stringify(healthy.tests));
    assert.equal(healthy.summary.passed, 3);
    assert.equal(healthy.summary.skipped, 1);
    assert.equal(healthy.bugs.length, 0);

    const r2 = await demo('2');
    const release = await call(`/api/runs/${r2}/report`);
    assert.equal(release.summary.failed, 1, JSON.stringify(release.tests));
    assert.equal(release.healing.healed >= 2, true, 'the renamed ids were healed');
    assert.equal(release.bugs.length, 1);
    const bug = release.bugs[0];
    assert.equal(bug.status, 'open');
    assert.equal(bug.severity, 'high', 'TC-02 is a High priority scenario');
    assert.match(bug.test, /TC-02/);
    assert.deepEqual(release.scenarios.unattended.map((s: any) => s.id).sort(), ['TC-04', 'TC-05', 'TC-06']);
    assert.ok(release.coverage.pages.visited >= 2, 'settings and billing were visited');
    assert.ok(release.coverage.uncoveredPages.some((p: any) => p.url.endsWith('/demo/profile')), 'profile page was never opened');
    assert.ok(release.coverage.elements.total > release.coverage.elements.touched, 'some controls were never used');
    assert.equal(release.density.found, 1);
    assert.ok(release.risk.score > 25);

    const r3 = await demo('3');
    const fixed = await call(`/api/runs/${r3}/report`);
    assert.equal(fixed.summary.failed, 0);
    assert.equal(fixed.bugs[0].status, 'verified', 'evidence: ' + JSON.stringify({ summary: fixed.summary, tests: fixed.tests.map((t: any) => [t.title, t.status, t.file]), note: fixed.resultsNote, bug: fixed.bugs[0] }));
    assert.equal(fixed.bugs[0].retest.result, 'passed');
    assert.equal(fixed.retest.verified, 1);
    assert.equal(fixed.density.residual, 0);
    assert.ok(fixed.risk.score < release.risk.score, 'risk drops once the bug is verified fixed');

    // The release run's report is a record of that moment: its bug is still open there.
    const again = await call(`/api/runs/${r2}/report`);
    assert.equal(again.isLatest, false);
    assert.equal(again.latestId, r3);
    assert.equal(again.bugs[0].status, 'open');
    assert.equal(again.risk.score, release.risk.score);
  });
});
