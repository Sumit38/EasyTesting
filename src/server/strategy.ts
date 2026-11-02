import type { TestCase } from '../cases/model.js';
import { parseUseCase, type UseCase } from '../cases/usecase.js';
import type { Block } from './docx.js';

/**
 * The proposed test strategy for a set of test cases: the tester answers a few questions (most of them filled in
 * from the cases and the use case), and this turns the answers into a Word document with a cycle-by-cycle plan.
 */

export const TEST_TYPES = [
  'Smoke',
  'Functional',
  'Field validation',
  'Regression',
  'Re-testing of fixed defects',
  'Performance',
  'Security',
  'Accessibility',
  'Compatibility (browsers, devices)',
  'Usability',
  'Reliability (availability)',
  'User acceptance (UAT)',
  'API',
] as const;

export const DELIVERABLES = [
  'Test strategy (this document)',
  'Test cases (Excel)',
  'Run reports with screenshots for every step',
  'Defect reports',
  'Cycle summary report after each cycle',
  'Test closure report',
] as const;

export interface StrategyAnswers {
  project: string;
  release: string;
  version: string;
  preparedBy: string;
  approvedBy: string;
  objective: string;
  inScope: string;
  outOfScope: string;
  testTypes: string[];
  environments: string;
  browsers: string;
  testData: string;
  startDate: string;
  cycles: number;
  cycleDays: number;
  gapDays: number;
  automation: 'easytesting' | 'manual';
  team: string;
  entry: string;
  exit: string;
  passRate: number;
  defectTool: string;
  risks: string;
  assumptions: string;
  deliverables: string[];
}

const lines = (s: string, max = 60) =>
  String(s ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, max);
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n).trim();
const int = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** The category of a case; sets uploaded without one are treated as functional. */
const categoryOf = (c: TestCase) => c.category ?? (/valid|field|format|mandatory|required|length|boundary/i.test(`${c.scenario ?? ''} ${c.title}`) && /negative|boundary|edge/i.test(c.type ?? '') ? 'Field validation' : 'Functional');
const high = (c: TestCase) => /^(?:high|critical|blocker|urgent|p0|p1|1)$/i.test(String(c.priority ?? '').trim());
const scenarioOf = (c: TestCase) => (c.scenario || c.area || 'General').trim();
/** The part of a scenario name after the use case title: "Login - Main flow" → "Main flow". */
const shortScenario = (s: string) => s.replace(/^.+?\s[-–]\s/, '');

/** Which non-functional test types the cases already cover, from their scenario names. */
function nfrTypes(cases: TestCase[]): string[] {
  const text = cases.filter((c) => categoryOf(c) === 'Non-functional').map((c) => `${c.scenario ?? ''} ${c.title}`).join(' ').toLowerCase();
  const out: string[] = [];
  if (/perform|load|speed|response|throughput/.test(text)) out.push('Performance');
  if (/secur|https|mask|lockout|session|password/.test(text)) out.push('Security');
  if (/accessib|label|keyboard|contrast|wcag/.test(text)) out.push('Accessibility');
  if (/compatib|browser|device/.test(text)) out.push('Compatibility (browsers, devices)');
  if (/usab/.test(text)) out.push('Usability');
  if (/reliab|availab|uptime|99/.test(text)) out.push('Reliability (availability)');
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The Monday after `today` (or `today` itself if it is a Monday), as YYYY-MM-DD. */
export function nextMonday(today = new Date()): string {
  const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return iso(d);
}

/** Answers filled in from the cases and the use case, for the tester to change. */
export function strategyDefaults(title: string, cases: TestCase[], useCaseText?: string, appUrl?: string, today = new Date()): StrategyAnswers {
  const uc: UseCase | undefined = useCaseText ? parseUseCase(useCaseText) : undefined;
  const name = (uc?.title || title || 'The application').trim();
  const scenarios = [...new Set(cases.map(scenarioOf))];
  const fv = cases.some((c) => categoryOf(c) === 'Field validation');
  const manual = cases.filter((c) => c.manual).length;
  const types = ['Smoke', 'Functional', ...(fv ? ['Field validation'] : []), 'Regression', 'Re-testing of fixed defects', ...nfrTypes(cases), 'User acceptance (UAT)'];
  const actor = uc?.actor ? ` for the ${uc.actor.toLowerCase()}` : '';
  return {
    project: name,
    release: 'Release 1.0',
    version: '1.0',
    preparedBy: '',
    approvedBy: '',
    objective: `Confirm that ${name} works as the requirements describe${actor}: every flow gives the right result, every field accepts good input and rejects bad input with a clear message, and the non-functional needs (speed, security, accessibility) are met, before the release goes live.`,
    inScope: scenarios.map(shortScenario).filter((s, i, a) => a.indexOf(s) === i).slice(0, 30).join('\n'),
    outOfScope: ['Features not described in the use case or the test cases', 'Load testing with real production traffic', 'Third-party systems beyond the points where the app connects to them'].join('\n'),
    testTypes: [...new Set(types)],
    environments: appUrl ? `QA - ${appUrl}` : 'QA - (add the link of the test environment)',
    browsers: ['Google Chrome (latest)', 'Microsoft Edge (latest)', 'Mozilla Firefox (latest)'].join('\n'),
    testData: 'Test accounts and sample data are prepared before Cycle 1 and kept in the test cases. No real customer data is used.',
    startDate: nextMonday(today),
    cycles: 3,
    cycleDays: 5,
    gapDays: 2,
    automation: 'easytesting',
    team: ['Test lead | | Plans the cycles, tracks progress, reports status and signs off', 'Tester | | Runs the test cases, logs defects with evidence, re-tests fixes', 'Developer | | Fixes defects and supports the investigation of failures', 'Product owner | | Answers questions on the requirements and accepts the release in UAT'].join('\n'),
    entry: ['The build is deployed to the test environment and passes a smoke check', 'Requirements and test cases are reviewed and agreed', 'Test accounts and test data are ready', 'Open defects from the previous cycle are fixed or deferred with agreement'].join('\n'),
    exit: ['Every planned test case has been run', 'No Critical or High defect is open', `Medium and Low defects that remain are agreed with the product owner`, ...(manual ? [`The ${manual} manual check${manual === 1 ? ' is' : 's are'} done and recorded`] : [])].join('\n'),
    passRate: 95,
    defectTool: 'Jira',
    risks: [
      'The test environment is not ready or not stable | Check it the day before each cycle; keep a smoke run to confirm the build',
      'Requirements change during testing | Re-generate the test cases from the updated use case and re-plan the affected cycle',
      'Fixes arrive late and squeeze the last cycle | Agree fix dates in the defect triage; move low-risk cases to regression',
      ...(manual ? ['Manual checks take longer than planned | Book the people for them in the plan and do them early in the cycle'] : []),
      ...(cases.some((c) => categoryOf(c) === 'Non-functional') ? ['The test environment is slower or smaller than production | Treat speed results as a guide; confirm critical figures on a production-like environment'] : []),
    ].join('\n'),
    assumptions: ['The application is available in the test environment during the planned dates', 'The team members named here are available for the cycles', 'Defects are fixed within the agreed times'].join('\n'),
    deliverables: [...DELIVERABLES],
  };
}

/** Takes answers from the browser and keeps only what fits, falling back to the defaults. */
export function cleanAnswers(input: unknown, defaults: StrategyAnswers): StrategyAnswers {
  const b = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: keyof StrategyAnswers, n = 4000) => (b[k] === undefined ? (defaults[k] as string) : clip(b[k], n));
  const list = (k: 'testTypes' | 'deliverables', allowed: readonly string[]) => (Array.isArray(b[k]) ? (b[k] as unknown[]).map(String).filter((x) => allowed.includes(x)) : defaults[k]);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(b.startDate ?? '')) && !Number.isNaN(Date.parse(String(b.startDate))) ? String(b.startDate) : defaults.startDate;
  return {
    project: str('project', 200) || defaults.project,
    release: str('release', 200),
    version: str('version', 40) || '1.0',
    preparedBy: str('preparedBy', 200),
    approvedBy: str('approvedBy', 200),
    objective: str('objective'),
    inScope: str('inScope'),
    outOfScope: str('outOfScope'),
    testTypes: list('testTypes', TEST_TYPES),
    environments: str('environments'),
    browsers: str('browsers'),
    testData: str('testData'),
    startDate: start,
    cycles: int(b.cycles, 1, 6, defaults.cycles),
    cycleDays: int(b.cycleDays, 1, 30, defaults.cycleDays),
    gapDays: int(b.gapDays, 0, 10, defaults.gapDays),
    automation: b.automation === 'manual' ? 'manual' : b.automation === 'easytesting' ? 'easytesting' : defaults.automation,
    team: str('team'),
    entry: str('entry'),
    exit: str('exit'),
    passRate: int(b.passRate, 50, 100, defaults.passRate),
    defectTool: str('defectTool', 100) || defaults.defectTool,
    risks: str('risks'),
    assumptions: str('assumptions'),
    deliverables: list('deliverables', DELIVERABLES),
  };
}

/* ---------- the cycle plan ---------- */

export interface Cycle {
  name: string;
  focus: string;
  start: string;
  end: string;
  objective: string;
  activities: string[];
  cases: TestCase[];
  entry: string[];
  exit: string[];
}

/** Adds working days (Monday to Friday) to a date. `days` = 0 moves a weekend date to the Monday. */
function addWorkingDays(date: string, days: number): Date {
  const d = new Date(`${date}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  for (let left = days; left > 0; ) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
  }
  return d;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const showDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Splits the cases into cycles. One cycle runs everything. With more: Cycle 1 is smoke plus the functional and
 * field checks; the next covers the non-functional checks with re-tests and regression of the important cases;
 * any further middle cycles are regression rounds; the last runs everything again for sign-off.
 */
export function planCycles(cases: TestCase[], a: Pick<StrategyAnswers, 'cycles' | 'cycleDays' | 'gapDays' | 'startDate' | 'passRate'>): Cycle[] {
  const fn = cases.filter((c) => categoryOf(c) !== 'Non-functional');
  const nf = cases.filter((c) => categoryOf(c) === 'Non-functional');
  const important = fn.filter(high);
  const smoke = (important.length ? important : fn.filter((c, i) => fn.findIndex((x) => scenarioOf(x) === scenarioOf(c)) === i)).filter((c) => !c.manual);
  const n = a.cycles;
  const shapes: Omit<Cycle, 'start' | 'end'>[] = [];
  const firstEntry = ['The build is deployed to the test environment', 'The smoke check passes', 'Test data and accounts are ready'];
  const nextEntry = (k: number) => [`Cycle ${k - 1} is finished and its summary is shared`, 'A new build with the fixes is deployed', 'The smoke check passes on the new build'];
  if (n === 1) {
    shapes.push({
      name: 'Cycle 1', focus: 'Full test cycle', objective: 'Run every test case once, fix what fails and re-test it, then sign off.',
      activities: ['Smoke check of the build', 'Run all functional and field validation cases', 'Run the non-functional checks', 'Log defects; re-test every fix', 'Write the test closure report'],
      cases, entry: firstEntry, exit: [`At least ${a.passRate}% of the test cases pass`, 'No Critical or High defect is open', 'The closure report is shared'],
    });
  } else {
    shapes.push({
      name: 'Cycle 1', focus: 'Smoke, functional and field validation', objective: 'Find the most defects as early as possible: check the main flows end to end and every field rule.',
      activities: ['Smoke check of the build with the most important cases', 'Run all functional cases (main flow, alternate flows, requirements)', 'Run all field validation cases', 'Log every defect with steps and screenshots', 'Daily defect triage with the developers'],
      cases: fn, entry: firstEntry, exit: ['Every Cycle 1 case has been run', 'Every defect found is logged and triaged', 'No Critical defect is left without a fix plan'],
    });
    if (n >= 3) {
      shapes.push({
        name: 'Cycle 2', focus: 'Non-functional, re-test and regression', objective: 'Check speed, security and accessibility, re-test the fixes from Cycle 1, and make sure the fixes broke nothing else.',
        activities: ['Re-test every defect fixed since Cycle 1', 'Run the non-functional checks', 'Regression of the important functional cases', 'Re-run the Cycle 1 cases that failed'],
        cases: [...nf, ...important.filter((c) => !nf.includes(c))], entry: nextEntry(2), exit: ['Every fixed defect is re-tested', 'Every non-functional check has been run', 'No Critical defect is open'],
      });
      for (let k = 3; k < n; k++) {
        shapes.push({
          name: `Cycle ${k}`, focus: 'Regression and re-test', objective: 'Re-test the latest fixes and run the full regression to confirm the build is stable.',
          activities: ['Re-test every defect fixed since the previous cycle', 'Full regression of the automated cases', 'Run the failed and blocked cases again'],
          cases: cases.filter((c) => !c.manual), entry: nextEntry(k), exit: ['Every fixed defect is re-tested', 'No Critical or High defect is open', 'The pass rate is going up from the previous cycle'],
        });
      }
    }
    shapes.push({
      name: `Cycle ${n}`, focus: n === 2 ? 'Non-functional, full regression and sign-off' : 'Full regression, UAT support and sign-off',
      objective: 'Run every test case on the release candidate, support user acceptance, and confirm the release meets the exit criteria.',
      activities: ['Re-test every remaining fix', 'Full regression: all automated cases', ...(n === 2 ? ['Run the non-functional checks'] : []), 'Manual checks', 'Support user acceptance testing', 'Write the test closure report and ask for sign-off'],
      cases, entry: nextEntry(n), exit: [`At least ${a.passRate}% of the test cases pass`, 'No Critical or High defect is open', 'Remaining defects are agreed with the product owner', 'The closure report is signed off'],
    });
  }
  let next = a.startDate;
  return shapes.map((s) => {
    const start = addWorkingDays(next, 0);
    const end = addWorkingDays(iso(start), a.cycleDays - 1);
    next = iso(addWorkingDays(iso(end), 1 + a.gapDays));
    return { ...s, start: iso(start), end: iso(end) };
  });
}

/* ---------- the document ---------- */

const split = (l: string) => l.split(/\s*\|\s*/);
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const TYPE_INFO: Record<string, { what: string; how: (auto: boolean) => string; cat?: string; nfr?: RegExp }> = {
  Smoke: { what: 'The most important flows work on each new build, before deeper testing starts.', how: (auto) => (auto ? 'Automated, at the start of every cycle' : 'Manual, at the start of every cycle') },
  Functional: { what: 'Main flow, alternate flows, business rules and functional requirements give the right result.', how: (auto) => (auto ? 'Automated in a real browser; manual where marked' : 'Manual'), cat: 'Functional' },
  'Field validation': { what: 'Each field accepts valid input and rejects empty, wrong-format and too-long input with a clear message.', how: (auto) => (auto ? 'Automated in a real browser' : 'Manual'), cat: 'Field validation' },
  Regression: { what: 'Fixes and new changes have not broken what worked before.', how: (auto) => (auto ? 'Automated: the whole set is run again' : 'Manual, important cases first') },
  'Re-testing of fixed defects': { what: 'Every fixed defect is checked again with the steps that found it.', how: (auto) => (auto ? 'Automated re-test from the defect, with before and after screenshots' : 'Manual') },
  Performance: { what: 'Pages load and respond within the agreed times.', how: () => 'Page load time checked in the browser; load testing with a dedicated tool if needed', nfr: /perform|load|speed|response|throughput/i },
  Security: { what: 'Passwords are hidden, traffic is over HTTPS, sessions and lockouts behave as required.', how: () => 'Automated checks plus manual review', nfr: /secur|https|mask|lockout|session|password/i },
  Accessibility: { what: 'Fields have labels, the page works with a keyboard, contrast is readable (WCAG 2.1 AA).', how: () => 'Automated label checks plus manual keyboard and contrast review', nfr: /accessib|label|keyboard|contrast|wcag/i },
  'Compatibility (browsers, devices)': { what: 'The app works the same on the supported browsers and devices.', how: () => 'Manual, on each browser in section 4', nfr: /compatib|browser|device/i },
  Usability: { what: 'The app is easy to understand and use for its users.', how: () => 'Manual review and feedback in UAT', nfr: /usab/i },
  'Reliability (availability)': { what: 'The app stays available and recovers from failures as required.', how: () => 'Manual: monitoring of uptime over the test period, with the operations team', nfr: /reliab|availab|uptime|99/i },
  'User acceptance (UAT)': { what: 'The business users confirm the release does what they need.', how: () => 'Manual, by the product owner and business users' },
  API: { what: 'The services behind the screens return the right data and errors.', how: () => 'API calls with a tool such as Postman; not covered by these test cases' },
};

const SEVERITY = [
  ['Critical', 'The app or a main flow cannot be used, data is lost, or there is a security hole. No way around it.', 'Within 1 working day'],
  ['High', 'An important feature gives the wrong result; a way around it exists but is not acceptable for release.', 'Within 2 working days'],
  ['Medium', 'A feature works but not fully as required; there is an acceptable way around it.', 'Within the cycle'],
  ['Low', 'Cosmetic: wording, layout, spelling. No effect on how the app works.', 'Before release, or deferred by agreement'],
];

/** The blocks of the Word document. */
export function strategyDocument(title: string, cases: TestCase[], a: StrategyAnswers, today = new Date()): Block[] {
  const auto = a.automation === 'easytesting';
  const cycles = planCycles(cases, a);
  const automated = cases.filter((c) => !c.manual).length;
  const manual = cases.length - automated;
  const byCat = (cat: string) => cases.filter((c) => categoryOf(c) === cat).length;
  const out: Block[] = [];
  const h1 = (t: string) => out.push({ kind: 'h1', text: t });
  const h2 = (t: string) => out.push({ kind: 'h2', text: t });
  const p = (t: string) => out.push({ kind: 'p', text: t });
  const bullets = (items: string[], empty = 'None.') => out.push(items.length ? { kind: 'bullets', items } : { kind: 'p', text: empty, muted: true });
  const table = (header: string[], rows: string[][], widths?: number[], keyColumn = false) => out.push({ kind: 'table', header, rows, widths, keyColumn });
  const end = cycles[cycles.length - 1].end;
  const closure = iso(addWorkingDays(end, 1));
  const prepStart = (() => {
    const d = new Date(`${cycles[0].start}T00:00:00Z`);
    for (let left = 2; left > 0; ) {
      d.setUTCDate(d.getUTCDate() - 1);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left--;
    }
    return iso(d);
  })();
  const prepEnd = (() => {
    const d = new Date(`${cycles[0].start}T00:00:00Z`);
    do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return iso(d);
  })();

  // Cover
  out.push({ kind: 'title', text: 'Test Strategy' });
  out.push({ kind: 'subtitle', text: [a.project, a.release].filter(Boolean).join(' - ') });
  table(['Document detail', ''], [
    ['Project', a.project],
    ['Release', a.release || '-'],
    ['Test case set', title],
    ['Version', a.version],
    ['Status', 'Draft for review'],
    ['Prepared by', a.preparedBy || '-'],
    ['Approved by', a.approvedBy || '-'],
    ['Date', showDate(iso(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))))],
  ], [1, 2.4], true);
  p(`Testing runs in ${count(cycles.length, 'cycle')} from ${showDate(cycles[0].start)} to ${showDate(end)}, covering ${count(cases.length, 'test case')} (${automated} automated, ${manual} manual).`);
  out.push({ kind: 'pagebreak' });

  // 1. Introduction
  h1('1. Introduction');
  h2('1.1 Purpose');
  p(`This document sets out how ${a.project}${a.release ? ` (${a.release})` : ''} will be tested: what is tested and what is not, how, where, by whom, in which cycles and on which dates, and what has to be true before testing can start and before the release can go live.`);
  h2('1.2 Objective');
  p(a.objective || '-');
  h2('1.3 Summary');
  table(['Item', 'Plan'], [
    ['Test cases', `${cases.length} in total: ${byCat('Functional')} functional, ${byCat('Field validation')} field validation, ${byCat('Non-functional')} non-functional`],
    ['Execution', auto ? `${automated} automated with EasyTesting in a real browser, ${manual} done by hand` : `All ${cases.length} run by hand`],
    ['Test cycles', cycles.map((c) => `${c.name}: ${c.focus}`).join('\n')],
    ['Dates', `${showDate(cycles[0].start)} to ${showDate(end)}`],
    ['Go-live condition', `At least ${a.passRate}% pass and no Critical or High defect open`],
  ], [1, 3], true);

  // 2. Scope
  h1('2. Scope');
  h2('2.1 In scope');
  bullets(lines(a.inScope));
  h2('2.2 Out of scope');
  bullets(lines(a.outOfScope));

  // 3. Approach
  h1('3. Test approach');
  p('The test types below are used. The number of cases shows how many of this set\'s test cases cover each type.');
  table(['Test type', 'What is checked', 'How', 'Cases'], a.testTypes.map((t) => {
    const info = TYPE_INFO[t];
    const n = info?.cat ? byCat(info.cat) : info?.nfr ? cases.filter((c) => categoryOf(c) === 'Non-functional' && info.nfr!.test(`${c.scenario ?? ''} ${c.title}`)).length : t === 'Smoke' ? cycles[0].cases.filter((c) => !c.manual && high(c)).length || '-' : t === 'Regression' ? automated : '-';
    return [t, info?.what ?? '', info?.how(auto) ?? '', String(n || '-')];
  }), [1.2, 2.6, 1.8, 0.5], true);
  h2('3.1 Automated testing');
  p(auto
    ? `${automated} test cases are run with EasyTesting in a real browser. Every step is recorded with a screenshot, failures are explained in plain language, and when the page changes the tool finds the element again (self-healing) and says so in the report. Automated cases are re-run in every regression and re-test.`
    : 'All test cases are run by hand by the testers, following the steps in the test case sheet, and the result of each step is recorded.');
  h2('3.2 Manual testing');
  p(manual
    ? `${count(manual, 'check is', 'checks are')} done by hand (for example load, browser compatibility, session time-out, keyboard use). They are marked "Manual" in the test case sheet and recorded in the cycle summary.`
    : 'Exploratory testing is done by hand at the end of each cycle, around the areas where defects were found.');
  h2('3.3 Test case design');
  p('Test cases were written from the use case: the main flow (positive), each alternate flow (negative), each field rule (empty, wrong format, too long, boundary values), each functional requirement and each non-functional requirement. Where the use case did not say what should happen, the expectation is marked "assumed" in the sheet and should be confirmed with the product owner.');

  // 4. Environment
  h1('4. Test environment and data');
  h2('4.1 Environments');
  table(['Environment', 'Link or detail'], lines(a.environments).map((l) => {
    const m = l.match(/^(.+?)\s+[-–:]\s+(.+)$/);
    return m ? [m[1], m[2]] : [l, ''];
  }), [1, 3], true);
  h2('4.2 Browsers and devices');
  bullets(lines(a.browsers));
  h2('4.3 Test data');
  p(a.testData || '-');

  // 5. Cycles
  h1('5. Test cycle plan');
  p(`${count(cycles.length, 'cycle')} of ${count(a.cycleDays, 'working day')} each${cycles.length > 1 && a.gapDays ? `, with ${count(a.gapDays, 'working day')} between cycles for fixes and a new build` : ''}.`);
  table(['Cycle', 'Dates', 'Focus', 'Cases', 'Exit'], cycles.map((c) => [c.name, `${showDate(c.start)}\nto ${showDate(c.end)}`, c.focus, String(c.cases.length), c.exit[0]]), [0.8, 1.4, 1.8, 0.5, 1.8], true);
  for (const c of cycles) {
    h2(`5.${cycles.indexOf(c) + 1} ${c.name}: ${c.focus}`);
    table(['', ''], [
      ['Dates', `${showDate(c.start)} to ${showDate(c.end)} (${count(a.cycleDays, 'working day')})`],
      ['Objective', c.objective],
      ['Test cases', `${c.cases.length}: ${c.cases.filter((x) => !x.manual).length} automated, ${c.cases.filter((x) => x.manual).length} manual`],
    ], [1, 3.4], true);
    out.push({ kind: 'h3', text: 'Activities' });
    bullets(c.activities);
    out.push({ kind: 'h3', text: 'Entry criteria' });
    bullets(c.entry);
    out.push({ kind: 'h3', text: 'Exit criteria' });
    bullets(c.exit);
  }

  // 6. Schedule
  h1('6. Schedule and milestones');
  const sched: string[][] = [['Test preparation: environment, data, review of test cases', showDate(prepStart), showDate(prepEnd), 'Test lead, testers']];
  cycles.forEach((c, i) => {
    sched.push([`${c.name}: ${c.focus}`, showDate(c.start), showDate(c.end), 'Testers']);
    if (i < cycles.length - 1 && a.gapDays) {
      const fixStart = iso(addWorkingDays(c.end, 1));
      const fixEnd = iso(addWorkingDays(c.end, a.gapDays));
      sched.push(['Fixes and new build', showDate(fixStart), showDate(fixEnd), 'Developers']);
    }
  });
  sched.push(['Test closure report and sign-off', showDate(closure), showDate(closure), 'Test lead, product owner']);
  table(['Activity', 'Start', 'End', 'Who'], sched, [2.6, 1.1, 1.1, 1.3]);

  // 7. Criteria
  h1('7. Entry and exit criteria');
  h2('7.1 Entry criteria (before testing starts)');
  bullets(lines(a.entry));
  h2('7.2 Exit criteria (before the release goes live)');
  bullets([...lines(a.exit), ...(lines(a.exit).some((l) => /\d+\s*%/.test(l)) ? [] : [`At least ${a.passRate}% of the test cases pass`])]);
  h2('7.3 Suspension and resumption');
  bullets(['Testing stops when a Critical defect blocks a main flow, the environment is down, or the build fails the smoke check.', 'Testing resumes when a fixed build passes the smoke check; the blocked cases are run again first.']);

  // 8. Defects
  h1('8. Defect management');
  p(`Defects are logged in ${a.defectTool}${auto ? ' (from EasyTesting, with the failed step, screenshots and a link back to the run)' : ''}. Each defect has a title, steps to reproduce, expected and actual result, evidence, severity and the build it was found on.`);
  h2('8.1 Severity');
  table(['Severity', 'Meaning', 'Target fix time'], SEVERITY, [0.8, 3, 1.2], true);
  h2('8.2 Life cycle');
  p('New → Triaged → In progress → Fixed → Re-test → Closed. A defect that fails its re-test goes back to In progress. A defect that will not be fixed in this release is Deferred with the product owner\'s agreement.');
  h2('8.3 Triage');
  p('The test lead, a developer and the product owner meet daily during each cycle to agree severity, owner and fix date of every new defect.');

  // 9. Team
  h1('9. Roles and responsibilities');
  table(['Role', 'Name', 'Responsibilities'], lines(a.team).map((l) => {
    const [role, name, resp] = split(l);
    return [role || '-', name || 'To be named', resp || ''];
  }), [1.1, 1.1, 3], true);

  // 10. Risks
  h1('10. Risks and mitigation');
  table(['#', 'Risk', 'Mitigation'], lines(a.risks).map((l, i) => {
    const [risk, ...rest] = split(l);
    return [String(i + 1), risk, rest.join(' | ') || 'To be agreed'];
  }), [0.3, 2.3, 2.6]);

  // 11. Assumptions
  h1('11. Assumptions and dependencies');
  bullets(lines(a.assumptions));

  // 12. Deliverables
  h1('12. Deliverables');
  bullets(a.deliverables);

  // 13. Approval
  h1('13. Approval');
  table(['Role', 'Name', 'Signature', 'Date'], [['Prepared by', a.preparedBy, '', ''], ['Reviewed by', '', '', ''], ['Approved by', a.approvedBy, '', '']], [1, 1.6, 1.4, 1]);

  // Appendices
  out.push({ kind: 'pagebreak' });
  h1('Appendix A. Requirement coverage');
  const scen = [...new Set(cases.map(scenarioOf))];
  table(['Scenario', 'Cases', 'Functional', 'Field validation', 'Non-functional', 'Manual'], scen.map((s) => {
    const cs = cases.filter((c) => scenarioOf(c) === s);
    const k = (cat: string) => String(cs.filter((c) => categoryOf(c) === cat).length);
    return [s, String(cs.length), k('Functional'), k('Field validation'), k('Non-functional'), String(cs.filter((c) => c.manual).length)];
  }), [2.8, 0.6, 0.8, 0.8, 0.9, 0.6]);
  h1('Appendix B. Test cases by cycle');
  table(['ID', 'Test case name', 'Requirement type', 'Priority', 'Execution', ...cycles.map((c) => c.name.replace('Cycle ', 'C'))], cases.map((c) => [
    c.id, c.title, categoryOf(c), c.priority || '-', c.manual ? 'Manual' : auto ? 'Automated' : 'Manual', ...cycles.map((cy) => (cy.cases.includes(c) ? '✓' : '')),
  ]), [0.9, 3, 1.1, 0.7, 0.9, ...cycles.map(() => 0.35)]);
  return out;
}
