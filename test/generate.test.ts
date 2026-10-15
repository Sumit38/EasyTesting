import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateCases } from '../src/cases/generate.js';
import { casesToRows, detectMapping, hasHeaderRow, rowsToCases } from '../src/cases/model.js';
import { parseStep } from '../src/cases/steps.js';
import { parseUseCase } from '../src/cases/usecase.js';
import { readXlsx, writeXlsx } from '../src/server/xlsx.js';
import { parseCsvRows, writeCsv } from '../src/server/csv.js';

const LOGIN = `Use Case: User Login
Actor: Registered customer
Preconditions: The customer has an account
Main Flow:
1. The user opens the login page
2. The user enters email and password
3. The user clicks the Sign in button
4. The system redirects the user to the dashboard
5. The system shows "Welcome back"
Alternate Flows:
A1. Wrong password: the system shows "Invalid credentials"
A2. Email left blank: the system shows an error
Business Rules:
- The password must be at least 8 characters
- The email must be a valid address
`;

describe('use case reader', () => {
  it('finds the parts of a use case', () => {
    const uc = parseUseCase(LOGIN);
    assert.equal(uc.title, 'User Login');
    assert.equal(uc.actor, 'Registered customer');
    assert.equal(uc.mainFlow.length, 5);
    assert.equal(uc.alternates.length, 2);
    assert.equal(uc.rules.length, 2);
    assert.deepEqual(uc.preconditions, ['The customer has an account']);
  });

  it('reads a use case with no headings as a list of steps', () => {
    const uc = parseUseCase('The user opens the app. The user clicks Sign in. The system shows the dashboard.');
    assert.equal(uc.mainFlow.length >= 3, true, JSON.stringify(uc));
  });

  it('reads Given / When / Then acceptance criteria', () => {
    const uc = parseUseCase('User story: Search\nAs a shopper I want to search\nAcceptance criteria:\nGiven the shopper is on the home page\nWhen the shopper enters "shoes" in the Search field\nAnd the shopper clicks the Search button\nThen the system shows "Results for shoes"');
    assert.equal(uc.scenarios.length, 1);
    assert.equal(uc.scenarios[0].when.length, 2);
    assert.equal(uc.scenarios[0].then.length, 1);
  });
});

describe('rule-based generation', () => {
  const out = generateCases(LOGIN, { startPage: '/login' });
  const byTitle = (re: RegExp) => out.cases.find((c) => re.test(c.title));

  it('writes the happy path, with the test data it had to assume', () => {
    const main = byTitle(/main flow succeeds/)!;
    assert.deepEqual(main.steps.slice(0, 3), ['Open "/login"', 'Enter "tester@example.com" in the Email field', 'Enter "Password1!" in the Password field']);
    assert.equal(main.steps.at(-1), 'Verify "Welcome back" is displayed');
    assert.ok(out.notes.some((n) => /Email: a sample value/.test(n)));
  });

  it('the first step really opens the start page (not just something the reader tolerates)', () => {
    const first = parseStep(out.cases[0].steps[0]);
    assert.equal(first.action, 'open');
    assert.equal(first.value, '/login');
    assert.ok(first.confidence >= 0.95);
  });

  it('adds negative, boundary and alternate cases from the text', () => {
    assert.ok(byTitle(/Email left empty/));
    assert.ok(byTitle(/invalid email address in Email/));
    assert.ok(byTitle(/Password one character too short \(7\)/));
    assert.ok(!byTitle(/Password exactly 8 characters/), 'a valid-length password needs the real account, so it is left to the tester');
    assert.ok(out.notes.some((n) => /needs a real account/.test(n)));
    assert.ok(byTitle(/Wrong password/));
    const wrong = byTitle(/Wrong password/)!;
    assert.ok(wrong.steps.some((s) => /WrongPassword9!/.test(s)));
    assert.equal(wrong.steps.at(-1), 'Verify "Invalid credentials" is displayed');
    assert.equal(wrong.expected, 'The message "Invalid credentials" is shown');
    assert.deepEqual(new Set(out.cases.map((c) => c.type)), new Set(['Positive', 'Negative', 'Boundary', 'Alternate']));
  });

  it('negative cases stop before the success checks', () => {
    const empty = byTitle(/Email left empty/)!;
    assert.ok(empty.steps.includes('Leave the Email field empty'));
    assert.ok(!empty.steps.some((s) => /redirected|Welcome back/.test(s)));
    assert.equal(empty.steps.at(-1), 'Verify an error message is displayed');
  });

  it('labels what the use case states and what the generator had to guess', () => {
    const basis = (re: RegExp) => byTitle(re)!.basis;
    assert.equal(basis(/main flow succeeds/), 'stated');
    assert.equal(basis(/Email left empty/), 'stated', 'the use case has an alternate flow about a blank email');
    assert.equal(basis(/Password left empty/), 'assumed', 'nothing says the password is required');
    assert.equal(basis(/Wrong password/), 'stated');
    assert.equal(basis(/very long Email/), 'assumed');
    assert.equal(basis(/invalid email address in Email/), 'stated', 'a rule says the email must be valid');
    assert.ok(out.notes.some((n) => /rest on assumptions/.test(n)));
  });

  it('every generated step is one the step reader understands', () => {
    for (const c of out.cases) {
      for (const s of c.steps) {
        const p = parseStep(s);
        assert.ok(p.action !== 'unknown' && p.confidence >= 0.6, `${c.id} "${s}" -> ${JSON.stringify(p)}`);
      }
    }
  });

  it('uses supplied test data instead of samples', () => {
    const o = generateCases(LOGIN, { testData: { email: 'sam@acme.io', password: 'Hunter2hunter2!' } });
    const main = o.cases.find((c) => /main flow/.test(c.title))!;
    assert.ok(main.steps.includes('Enter "sam@acme.io" in the Email field'));
    assert.ok(main.steps.includes('Enter "Hunter2hunter2!" in the Password field'));
  });

  it('turns acceptance scenarios into cases', () => {
    const o = generateCases('Feature: Search\nAcceptance criteria:\nGiven the shopper is on the home page\nWhen the shopper enters "shoes" in the Search field\nAnd the shopper clicks the Search button\nThen the system shows "Results for shoes"');
    const c = o.cases.find((x) => x.type === 'Acceptance')!;
    assert.ok(c, JSON.stringify(o.cases));
    assert.ok(c.steps.includes('Enter "shoes" in the Search field'));
    assert.equal(c.steps.at(-1), 'Verify "Results for shoes" is displayed');
  });
});

describe('spreadsheets of test cases', () => {
  const cases = generateCases(LOGIN).cases;

  it('round-trips through Excel', () => {
    const rows = casesToRows(cases);
    const back = readXlsx(writeXlsx(rows, 'Test cases'));
    assert.deepEqual(back, rows);
    const header = back[0];
    assert.ok(hasHeaderRow(back));
    const { cases: again, warnings } = rowsToCases(back, detectMapping(header), true);
    assert.equal(warnings.length, 0);
    assert.deepEqual(again.map((c) => [c.id, c.title, c.steps, c.expected, c.basis]), cases.map((c) => [c.id, c.title, c.steps, c.expected, c.basis]));
    assert.ok(cases.some((c) => c.basis === 'assumed') && cases.some((c) => c.basis === 'stated'));
  });

  it('round-trips through CSV, including steps with commas, quotes and negative numbers', () => {
    const tricky = [{ id: 'TC-1', title: 'A, "B"', steps: ['Enter "-5" in the Amount field', 'Click "Save, then close"'], expected: '=1+1', type: 'Boundary' }];
    const rows = casesToRows(tricky);
    const text = writeCsv(rows);
    assert.ok(text.includes("'=1+1"), 'formula text is neutralised for spreadsheets');
    const back = parseCsvRows(text);
    const { cases: again } = rowsToCases(back, detectMapping(back[0]), true);
    assert.deepEqual(again[0].steps, tricky[0].steps);
    assert.equal(again[0].expected, '=1+1');
    assert.equal(again[0].title, 'A, "B"');
  });

  it('understands other people’s column names and the one-row-per-step layout', () => {
    const rows = [
      ['Test Case ID', 'Test Case Description', 'Test Steps', 'Expected Outcome', 'Module'],
      ['LG_01', 'Valid login', '1. Open the app\n2. Click Sign in', 'Dashboard shows', 'Login'],
      ['LG_02', 'Invalid login', 'Open the app', 'Error shows', 'Login'],
      ['', '', 'Click Sign in', 'Error appears', ''],
    ];
    const m = detectMapping(rows[0]);
    assert.equal(m.id, 0);
    assert.equal(m.title, 1);
    assert.equal(m.steps, 2);
    assert.equal(m.expected, 3);
    assert.equal(m.area, 4);
    const { cases: got } = rowsToCases(rows, m, true);
    assert.equal(got.length, 2);
    assert.deepEqual(got[0].steps, ['Open the app', 'Click Sign in']);
    assert.deepEqual(got[1].steps, ['Open the app', 'Click Sign in'], 'the extra row became a second step');
    assert.equal(got[1].expected, 'Error shows; Error appears');
  });

  it('semicolon-delimited CSV (common in some regions) is read correctly', () => {
    const rows = parseCsvRows('ID;Title;Steps\r\nTC-1;Log in, then out;"1. Open the app\n2. Click ""Go"""\r\n');
    assert.equal(rows[1][1], 'Log in, then out');
    assert.equal(rows[1][2], '1. Open the app\n2. Click "Go"');
  });
});

describe('guessing the columns of a tester\'s file', () => {
  it('knows the usual headings', () => {
    const m = detectMapping(['TC ID', 'Test Scenario', 'Module', 'Priority', 'Steps to Reproduce', 'Test Data', 'Expected Result']);
    assert.deepEqual([m.id, m.title, m.area, m.priority, m.steps, m.expected], [0, 1, 2, 3, 4, 6]);
  });
});
