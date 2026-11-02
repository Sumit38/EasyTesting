import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readDocx, readPdf } from '../src/cases/documents.js';
import { generateCases } from '../src/cases/generate.js';
import { casesToRows, detectMapping, rowsToCases, type TestCase } from '../src/cases/model.js';
import { parseStep } from '../src/cases/steps.js';
import { runCases } from '../src/exec/runner.js';
import { createApp } from '../src/server/index.js';
import { readXlsx } from '../src/server/xlsx.js';

// Made in Microsoft Word: headings, a numbered main flow, a table of alternate flows, functional and non-functional requirements.
const docx = readFileSync(new URL('./fixtures/login-usecase.docx', import.meta.url));
const pdf = readFileSync(new URL('./fixtures/login-usecase.pdf', import.meta.url));

describe('reading Word and PDF use cases', () => {
  it('reads a Word file: numbered steps keep their numbers, table rows keep their cells', () => {
    const text = readDocx(docx);
    assert.match(text, /^Use Case: Customer Login$/m);
    assert.match(text, /^1\. The customer opens the login page\.$/m);
    assert.match(text, /^4\. The system displays the dashboard\.$/m);
    assert.match(text, /^A1\tWrong password: the system shows "Invalid email or password"\.$/m);
  });
  it('reads the PDF of the same document into the same lines, joining sentences that wrap', async () => {
    const text = await readPdf(pdf);
    assert.match(text, /^1\. The customer opens the login page\.$/m);
    assert.match(text, /^A2\tEmail left empty: the system shows "Email is required"\.$/m);
    assert.match(text, /^NFR4: The account is locked after 5 failed login attempts\.$/m);
  });
  it('says plainly what to do with files it cannot read', async () => {
    assert.throws(() => readDocx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), /old Word file \(\.doc\)/);
    await assert.rejects(readPdf(new TextEncoder().encode('hello')), /not a PDF/);
  });
});

describe('test cases from a Word use case', () => {
  const out = generateCases(readDocx(docx));
  const by = (k: string) => out.cases.filter((c) => c.category === k);

  it('finds the functional and non-functional requirements', () => {
    assert.equal(out.useCase.requirements.length, 2);
    assert.equal(out.useCase.nonFunctional.length, 4);
  });
  it('covers functional, field validation and non-functional requirements, each case in a named scenario', () => {
    assert.ok(by('Functional').length >= 4 && by('Field validation').length >= 4 && by('Non-functional').length >= 4, out.analysis.summary);
    assert.ok(out.cases.every((c) => c.scenario?.startsWith('Customer Login - ') && c.category));
    assert.match(out.analysis.summary, /functional, \d+ field validation, \d+ non-functional/);
  });
  it('turns a length rule into boundary cases, and each stated requirement into its own case', () => {
    assert.ok(out.cases.some((c) => c.category === 'Field validation' && /Password one character too short \(7\)/.test(c.title)));
    assert.ok(out.cases.some((c) => /^FR2: /.test(c.title) && !c.manual && c.steps.at(-1) === 'Verify the dashboard is displayed'));
    const speed = out.cases.find((c) => /^NFR1: /.test(c.title))!;
    assert.deepEqual([speed.scenario, speed.steps.at(-1), !!speed.manual], ['Customer Login - Non-functional: Performance', 'Verify the page loads within 3 seconds', false]);
    assert.equal(out.cases.find((c) => /^NFR2: /.test(c.title))!.steps.at(-1), 'Verify the Password field is masked');
  });
  it('writes checks a browser cannot do (uptime, lockout) as manual cases with steps for a person', () => {
    const manual = out.cases.filter((c) => c.manual).map((c) => c.title);
    assert.deepEqual(manual.map((t) => t.slice(0, 5)), ['NFR3:', 'NFR4:']);
    assert.match(out.cases.find((c) => /^NFR4/.test(c.title))!.steps.join(' '), /wrong password 5 times/);
  });
  it('picks the field an alternate flow names, not one its message mentions', () => {
    const wrong = out.cases.find((c) => /Wrong password/.test(c.title))!;
    assert.ok(wrong.steps.includes('Enter "WrongPassword9!" in the Password field'), JSON.stringify(wrong.steps));
  });
  it('every automated step can be read by the runner', () => {
    const unclear = out.cases.filter((c) => !c.manual).flatMap((c) => c.steps).filter((s) => parseStep(s).confidence < 0.6);
    assert.deepEqual(unclear, []);
  });
});

describe('the Excel sheet', () => {
  it('has the test case columns in order, and reads back to the same cases', () => {
    const cases: TestCase[] = generateCases(readDocx(docx)).cases;
    const rows = casesToRows(cases);
    assert.deepEqual(rows[0].slice(0, 6), ['Test Case ID', 'Scenario Name', 'Test Case Name', 'Precondition', 'Test Case Steps', 'Expected Results']);
    const back = rowsToCases(rows, detectMapping(rows[0]), true).cases;
    assert.deepEqual(back.map((c) => [c.id, c.scenario, c.title, c.category, !!c.manual, c.steps]), cases.map((c) => [c.id, c.scenario, c.title, c.category, !!c.manual, c.steps]));
  });
  it('tells "Scenario Name" from "Test Case Name", and still takes a lone "Test Scenario" column as the name', () => {
    const m = detectMapping(['Test Case ID', 'Scenario Name', 'Test Case Name', 'Precondition', 'Test Case Steps', 'Expected Results']);
    assert.deepEqual([m.id, m.scenario, m.title, m.preconditions, m.steps, m.expected], [0, 1, 2, 3, 4, 5]);
    const lone = detectMapping(['TC ID', 'Test Scenario', 'Steps']);
    assert.deepEqual([lone.title, lone.scenario], [1, -1]);
  });
});

describe('the server', () => {
  it('reads an uploaded .docx and .pdf, generates, and downloads the sheet in the new columns', async () => {
    const { server } = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'docs-')) });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const read = async (name: string, body: Uint8Array) => {
        const r = await fetch(`${base}/api/usecases/read?filename=${name}`, { method: 'POST', body: body as unknown as BodyInit });
        return { status: r.status, body: (await r.json()) as { text?: string; error?: string } };
      };
      const w = await read('uc.docx', docx);
      const p = await read('uc.pdf', pdf);
      assert.equal(w.status, 200);
      assert.equal(p.status, 200);
      assert.match(p.body.text!, /Main Flow/);
      assert.equal((await read('old.doc', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).status, 400);

      const gen = await fetch(`${base}/api/usecases/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: w.body.text, method: 'rules' }) });
      const { suite } = (await gen.json()) as { suite: { id: number; cases: { manual?: boolean; interpreted: { action: string }[] }[] } };
      assert.ok(suite.cases.filter((c) => c.manual).every((c) => c.interpreted.every((s) => s.action === 'manual')), 'manual steps are not flagged as unclear');
      const x = await fetch(`${base}/api/suites/${suite.id}/download?format=xlsx`);
      const rows = readXlsx(new Uint8Array(await x.arrayBuffer()));
      assert.deepEqual(rows[0], ['Test Case ID', 'Scenario Name', 'Test Case Name', 'Precondition', 'Test Case Steps', 'Expected Results', 'Requirement Type', 'Test Type', 'Priority', 'Execution', 'Basis']);
      assert.ok(rows.some((r) => r[6] === 'Non-functional' && r[9] === 'Manual'));
    } finally {
      server.close();
    }
  });
});

describe('non-functional checks in a browser', () => {
  let site: Server;
  let origin = '';
  const PAGES: Record<string, string> = {
    '/good': '<label for="e">Email</label><input id="e"><label>Password <input type="password" id="p"></label>',
    '/bare': '<input placeholder="Email"><input name="code"><input type="text" id="pw" aria-label="Password">',
    '/slow': '<h1>Slow</h1><img src="/slow-image">',
  };
  before(async () => {
    site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/slow-image') return void setTimeout(() => { res.writeHead(404); res.end(); }, 1500);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>t</title><body>${PAGES[path] ?? ''}</body>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  const run = async (cases: TestCase[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'nfr-'));
    return (await runCases({ cases, appUrl: origin + '/good', healDir: dir, storeFile: join(dir, 'fp.db'), stepTimeout: 3000 })).results;
  };
  const tc = (id: string, steps: string[], extra: Partial<TestCase> = {}): TestCase => ({ id, title: id, steps, expected: '', ...extra });

  it('passes and fails load time, masking and labels as they really are, and skips manual cases', async () => {
    const r = await run([
      tc('fast', ['Open "/good"', 'Verify the page loads within 3 seconds', 'Verify the Password field is masked', 'Verify all fields have labels']),
      tc('slow', ['Open "/slow"', 'Verify the page loads within 1 second']),
      tc('unmasked', ['Open "/bare"', 'Verify the Password field is masked']),
      tc('unlabelled', ['Open "/bare"', 'Verify all fields have labels']),
      tc('https', ['Open "/good"', 'Verify the URL contains "https://"']),
      tc('by-hand', ['Monitor the uptime for a month'], { manual: true }),
    ]);
    const status = Object.fromEntries(r.map((x) => [x.id, x.status]));
    assert.deepEqual(status, { fast: 'passed', slow: 'failed', unmasked: 'failed', unlabelled: 'failed', https: 'passed', 'by-hand': 'skipped' }, JSON.stringify(r.map((x) => [x.id, x.steps.map((s) => s.error)])));
    const err = (id: string) => r.find((x) => x.id === id)!.steps.find((s) => s.status === 'failed')!.error ?? '';
    assert.match(err('slow'), /took 1\.\d+ seconds to load; the limit is 1 seconds/);
    assert.match(err('unlabelled'), /1 field has no label at all: "code"/);
    assert.match(r.find((x) => x.id === 'https')!.steps[1].notes.join(' '), /local address/);
    assert.match(r.find((x) => x.id === 'by-hand')!.advice ?? '', /manual check/);
  });
});
