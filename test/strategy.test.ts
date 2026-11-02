import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { readDocx } from '../src/cases/documents.js';
import { generateCases } from '../src/cases/generate.js';
import type { TestCase } from '../src/cases/model.js';
import { writeDocx } from '../src/server/docx.js';
import { createApp } from '../src/server/index.js';
import { cleanAnswers, nextMonday, planCycles, strategyDefaults, strategyDocument } from '../src/server/strategy.js';

const useCase = readDocx(readFileSync(new URL('./fixtures/login-usecase.docx', import.meta.url)));
const { cases } = generateCases(useCase);
const today = new Date(2026, 10, 2); // Mon 2 Nov 2026

describe('the strategy answers', () => {
  it('fill themselves in from the use case and the cases', () => {
    const a = strategyDefaults('Login', cases, useCase, 'https://qa.example.com', today);
    assert.match(a.project, /login/i);
    assert.equal(a.startDate, '2026-11-02');
    assert.ok(a.testTypes.includes('Functional') && a.testTypes.includes('Field validation'));
    assert.ok(['Performance', 'Security', 'Accessibility', 'Reliability (availability)'].every((t) => a.testTypes.includes(t)), a.testTypes.join(', '));
    assert.match(a.inScope, /Main flow/);
    assert.match(a.environments, /qa\.example\.com/);
    assert.match(a.exit, /manual check/);
  });

  it('start on the next Monday', () => {
    assert.equal(nextMonday(new Date(2026, 10, 4)), '2026-11-09');
    assert.equal(nextMonday(new Date(2026, 10, 8)), '2026-11-09');
  });

  it('keep only what is allowed', () => {
    const d = strategyDefaults('Login', cases, useCase, '', today);
    const a = cleanAnswers({ cycles: 99, cycleDays: -3, startDate: 'soon', testTypes: ['Functional', 'Hacking'], automation: 'robots', project: '  ', passRate: '80' }, d);
    assert.equal(a.cycles, 6);
    assert.equal(a.cycleDays, 1);
    assert.equal(a.startDate, d.startDate);
    assert.deepEqual(a.testTypes, ['Functional']);
    assert.equal(a.automation, d.automation);
    assert.equal(a.project, d.project);
    assert.equal(a.passRate, 80);
  });
});

describe('the cycle plan', () => {
  const base = { cycleDays: 5, gapDays: 2, startDate: '2026-11-02', passRate: 95 };

  it('runs everything in one cycle', () => {
    const [c] = planCycles(cases, { ...base, cycles: 1 });
    assert.equal(c.cases.length, cases.length);
    assert.deepEqual([c.start, c.end], ['2026-11-02', '2026-11-06']);
  });

  it('puts functional first, non-functional next and everything last, on working days', () => {
    const cs = planCycles(cases, { ...base, cycles: 3 });
    assert.equal(cs.length, 3);
    assert.ok(cs[0].cases.every((c) => c.category !== 'Non-functional'));
    assert.ok(cs[1].cases.some((c) => c.category === 'Non-functional'));
    assert.equal(cs[2].cases.length, cases.length);
    // 5 working days, then 2 days for fixes: Mon 2 → Fri 6, gap Mon 9 – Tue 10, next starts Wed 11.
    assert.deepEqual(cs.map((c) => [c.start, c.end]), [['2026-11-02', '2026-11-06'], ['2026-11-11', '2026-11-17'], ['2026-11-20', '2026-11-26']]);
    // Every case is planned somewhere.
    for (const c of cases) assert.ok(cs.some((cy) => cy.cases.includes(c)), c.id);
  });

  it('adds regression rounds in the middle, and moves a weekend start to Monday', () => {
    const cs = planCycles(cases, { ...base, cycles: 5, startDate: '2026-11-07' });
    assert.deepEqual(cs.map((c) => c.focus), ['Smoke, functional and field validation', 'Non-functional, re-test and regression', 'Regression and re-test', 'Regression and re-test', 'Full regression, UAT support and sign-off']);
    assert.equal(cs[0].start, '2026-11-09');
  });

  it('treats uploaded cases without a category as functional', () => {
    const up: TestCase[] = [{ id: 'A', title: 'Log in', steps: ['Open the application'], expected: 'ok', priority: 'High' }, { id: 'B', title: 'Bad email', steps: ['Open the application'], expected: 'error' }];
    const cs = planCycles(up, { ...base, cycles: 2 });
    assert.equal(cs[0].cases.length, 2);
    assert.equal(cs[1].cases.length, 2);
  });
});

describe('the Word document', () => {
  const answers = { ...strategyDefaults('Login', cases, useCase, 'https://qa.example.com', today), preparedBy: 'Asha & Co <QA>', team: 'Test lead | Asha | Plans\nTester' };
  const blocks = strategyDocument('Login', cases, answers, today);
  const file = writeDocx(blocks, { title: 'Test Strategy - Login', header: 'Test Strategy - Login' });

  it('has every section, the cycle plan and a row for every case', () => {
    const heads = blocks.filter((b) => b.kind === 'h1').map((b) => (b as { text: string }).text);
    assert.deepEqual(heads, ['1. Introduction', '2. Scope', '3. Test approach', '4. Test environment and data', '5. Test cycle plan', '6. Schedule and milestones', '7. Entry and exit criteria', '8. Defect management', '9. Roles and responsibilities', '10. Risks and mitigation', '11. Assumptions and dependencies', '12. Deliverables', '13. Approval', 'Appendix A. Requirement coverage', 'Appendix B. Test cases by cycle']);
    const tables = blocks.filter((b) => b.kind === 'table') as { header: string[]; rows: string[][] }[];
    const byCycle = tables.find((t) => t.header[1] === 'Test case name')!;
    assert.equal(byCycle.rows.length, cases.length);
    assert.deepEqual(byCycle.header.slice(-3), ['C1', 'C2', 'C3']);
    const team = tables.find((t) => t.header[2] === 'Responsibilities')!;
    assert.deepEqual(team.rows, [['Test lead', 'Asha', 'Plans'], ['Tester', 'To be named', '']]);
  });

  it('is a valid Word file that reads back', () => {
    const parts = unzipSync(file);
    for (const p of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml']) assert.ok(parts[p], p);
    const xml = strFromU8(parts['word/document.xml']);
    assert.match(xml, /Asha &amp; Co &lt;QA&gt;/, 'text is escaped');
    const text = readDocx(file);
    assert.match(text, /Test Strategy/);
    assert.match(text, /5\. Test cycle plan/);
    assert.match(text, /Cycle 1\tMon 02 Nov 2026/);
    assert.match(text, /Critical\t/);
  });
});

describe('the server', () => {
  it('serves the questions, a plan preview and the .docx', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'strategy-')) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const { suite } = (await (await post('/api/usecases/generate', { text: useCase, method: 'rules', appUrl: 'https://qa.example.com' })).json()) as { suite: { id: number } };
      const q = (await (await fetch(`${base}/api/suites/${suite.id}/strategy`)).json()) as { answers: { project: string; environments: string }; testTypes: string[]; cases: number };
      assert.match(q.answers.environments, /qa\.example\.com/);
      assert.equal(q.testTypes.length, 13);
      assert.ok(q.cases > 5);

      const prev = (await (await post(`/api/suites/${suite.id}/strategy?preview=1`, { cycles: 2, startDate: '2026-12-07' })).json()) as { cycles: { name: string; start: string }[] };
      assert.deepEqual(prev.cycles.map((c) => c.name), ['Cycle 1', 'Cycle 2']);
      assert.equal(prev.cycles[0].start, '2026-12-07');

      const r = await post(`/api/suites/${suite.id}/strategy`, { project: 'Shop login', release: 'R2' });
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type')!, /wordprocessingml/);
      assert.match(r.headers.get('content-disposition')!, /Test_Strategy_Shop_login\.docx/);
      assert.match(readDocx(new Uint8Array(await r.arrayBuffer())), /Shop login - R2/);
      assert.equal((await fetch(`${base}/api/suites/999/strategy`)).status, 404);
    } finally {
      server.close();
    }
  });
});
