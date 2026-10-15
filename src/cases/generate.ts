import type { TestCase } from './model.js';
import { parseStep } from './steps.js';
import { parseUseCase, type UseCase } from './usecase.js';

export interface GenerateOptions {
  /** Page to open first, as a path or full address. Without it the first step opens the app link. */
  startPage?: string;
  /** Known test data by field name, for example { email: 'sam@x.io', password: 'S3cret!' }. */
  testData?: Record<string, string>;
  /** Number to start numbering the cases from. */
  firstNumber?: number;
}

export interface Generated {
  cases: TestCase[];
  /** Things the person should look at before running. */
  notes: string[];
  useCase: UseCase;
  /** How well the use case was understood, for the person and for deciding whether to ask the AI instead. */
  analysis: Analysis;
}

export interface Analysis {
  title: string;
  actor?: string;
  /** What was found in the document. */
  found: { flowSteps: number; alternates: number; rules: number; preconditions: number; scenarios: number };
  /** Steps in the main test case. */
  mainSteps: number;
  /** 0-100: how sure the step reader is of the generated steps, on average. */
  understood: number;
  /** Steps under 60% across all cases: a name or a value is missing, or the step is unclear. */
  needYou: number;
  /** Sentences of the use case that could not become steps. */
  leftOut: number;
  quality: 'good' | 'fair' | 'poor';
  summary: string;
  advice: string[];
}

/** Grades what the generator made of a use case, and says what would make it better. */
export function analyse(uc: UseCase, cases: TestCase[], notes: string[]): Analysis {
  const all = cases.flatMap((c) => c.steps).map((s) => parseStep(s).confidence);
  const understood = all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) : 0;
  const needYou = all.filter((c) => c < 0.6).length;
  const leftOut = notes.filter((n) => /left out|not a step here|outside the website/.test(n)).length;
  const mainSteps = cases[0]?.steps.length ?? 0;
  const found = { flowSteps: uc.mainFlow.length, alternates: uc.alternates.length, rules: uc.rules.length, preconditions: uc.preconditions.length, scenarios: uc.scenarios.length };
  const quality: Analysis['quality'] = !cases.length || mainSteps < 3 || understood < 60 ? 'poor' : understood < 80 || needYou > 0 || leftOut > 3 ? 'fair' : 'good';
  const advice: string[] = [];
  if (!found.flowSteps && !found.scenarios) advice.push('No steps were found. Put the steps under a heading such as "Main Flow", one per line, each saying who does what: "The customer clicks Checkout".');
  else if (mainSteps < 3) advice.push('Only a few steps could be read. Write each step as one action: who does what, for example "The customer enters the email" or "The system shows the order number".');
  if (leftOut) advice.push(`${leftOut} sentence${leftOut === 1 ? ' was' : 's were'} not turned into steps (things that happen outside the browser, done by someone else, or not an action). They are listed in the notes.`);
  if (needYou) advice.push(`${needYou} step${needYou === 1 ? ' needs' : 's need'} a name or a value the use case does not give. Fill them in with "Fix the gaps" on the next screen.`);
  if (!found.alternates && !found.scenarios && cases.length) advice.push('There is no "Alternate Flows" section, so only the main flow and field checks were written. Add the error cases you care about to get tests for them.');
  const summary = !cases.length ? 'No test cases could be written from this text.'
    : `Found ${found.flowSteps || found.scenarios} ${found.flowSteps ? 'flow steps' : 'scenarios'}${found.alternates ? `, ${found.alternates} alternate flow${found.alternates === 1 ? '' : 's'}` : ''}${found.rules ? `, ${found.rules} rule${found.rules === 1 ? '' : 's'}` : ''}; wrote ${cases.length} test case${cases.length === 1 ? '' : 's'} and understood ${understood}% of their steps.`;
  return { title: uc.title, actor: uc.actor, found, mainSteps, understood, needYou, leftOut, quality, summary, advice };
}

type Kind = 'email' | 'password' | 'phone' | 'date' | 'postal' | 'number' | 'url' | 'text';

const KIND: [RegExp, Kind][] = [
  [/e-?mail/i, 'email'], [/pass(word|code)|\bpin\b/i, 'password'], [/phone|mobile|contact number|telephone/i, 'phone'], [/\bdate\b|\bdob\b|birth/i, 'date'],
  [/zip|postal|pin ?code/i, 'postal'], [/number|amount|quantity|qty|age|price|count/i, 'number'], [/\burl\b|website|web site|link/i, 'url'],
];
const kindOf = (field: string): Kind => KIND.find(([re]) => re.test(field))?.[1] ?? 'text';

const GOOD: Record<Kind, string> = { email: 'tester@example.com', password: 'Password1!', phone: '9876543210', date: '2024-01-15', postal: '12345', number: '10', url: 'https://example.com', text: 'Test value' };
const BAD: Partial<Record<Kind, [string, string]>> = {
  email: ['not-an-email', 'an invalid email address'], phone: ['12ab', 'letters in a phone number'], date: ['99/99/9999', 'an impossible date'],
  number: ['abc', 'letters in a number field'], url: ['not a url', 'text that is not a web address'], postal: ['ABCDE!', 'an invalid postal code'],
};

const title = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());
const stripArticle = (s: string) => s.replace(/^(?:the|a|an|his|her|their|its|valid|correct|his or her)\s+/i, '').trim();
const fieldLabel = (s: string) => title(stripArticle(stripArticle(s)).replace(/\s+(?:field|box|input)$/i, ''));

interface Planned {
  /** The step in the tool's step language. */
  text: string;
  /** Set when this step enters a value into a field. */
  field?: { name: string; kind: Kind };
  role: 'open' | 'enter' | 'submit' | 'verify' | 'other';
}

/** Verbs in the third person, as use cases write them: "The customer adds", "The system displays". */
const VERB = '(?:enters?|types?|inputs?|provides?|fills?|clicks?|presses?|taps?|selects?|chooses?|picks?|opens?|navigates?|goes|visits?|checks?|ticks?|submits?|views?|sees?|shows?|displays?|presents?|renders?|redirects?|logs?|signs?|uploads?|searches?|rejects?|prevents?|blocks?|denies?|sends?|confirms?|notifies?|validates?|keeps?|stays?|remains?|accepts?|agrees?|launch(?:es)?|access(?:es)?|takes?|adds?|removes?|proceeds?|makes?|pays?|places?|packs?|ships?|delivers?|receives?|updates?|cancels?|registers?|creates?|saves?|deletes?|edits?|processes?|records?|stores?|generates?|calculates?|charges?|reserves?|deducts?|assigns?|is|are)';

/** "The customer selects a product and adds it to the cart" is two steps; the second keeps the subject of the first. */
export function splitCompound(sentence: string): string[] {
  const parts = sentence.split(new RegExp(`(?:,\\s+(?:and\\s+|then\\s+|and then\\s+)?|\\s+(?:and then|then|and)\\s+)(?=(?:(?:it|he|she|they)\\s+)?${VERB}\\b)`, 'i'));
  if (parts.length === 1) return parts;
  const subject = parts[0].match(new RegExp(`^(.*?)(?=\\b${VERB}\\b)`, 'i'))?.[1] ?? '';
  return [parts[0], ...parts.slice(1).map((p) => subject + p.replace(/^(?:it|he|she|they)\s+/i, ''))];
}

/** Turns one sentence of a use case ("The user enters email and password") into steps. Returns none for what cannot be done in the browser. */
function plan(sentence: string, opts: GenerateOptions, first: boolean, notes: string[], actor?: string): Planned[] {
  let s = sentence.replace(/\s+/g, ' ').trim().replace(/[.;]$/, '');
  // Drop the subject ("The shopper", "The system") that comes before the verb. Sentences about the system become checks.
  const subject = s.match(new RegExp(`^((?:(?:the|a|an|then|and|but|also)\\s+)*(?:[a-z][a-z-]*\\s+){0,3}?)(?:(?:then|also|can|should|will|must|may)\\s+)*(?=${VERB}\\b)`, 'i'));
  let system = false;
  if (subject && subject[0].trim()) {
    system = /\b(?:system|application|app|site|website|page|server|screen|portal|platform|service|ui)\b/i.test(subject[1]);
    const who = subject[1].replace(/^(?:(?:the|a|an|then|and|but|also)\s+)+/i, '').trim();
    const isUser = !who || /\b(?:user|customer|shopper|buyer|visitor|member|client|guest|tester|he|she|they|i|we|you)\b/i.test(who) || !!actor?.split(/[\s,/]+/).some((w) => w.length > 2 && who.toLowerCase().includes(w.toLowerCase()));
    // "Warehouse staff ships the order": someone else, somewhere else. Not a step of this test.
    if (!system && !isUser) {
      const said = `is done by ${who}, not by the person using the website`;
      if (!notes.some((n) => n.includes(said))) notes.push(`"${sentence.trim()}" ${said}, so it is not a step here. Test it separately.`);
      return [];
    }
    s = s.slice(subject[0].length);
  }
  const verbFix: Record<string, string> = { enters: 'enter', types: 'type', inputs: 'input', provides: 'provide', clicks: 'click', presses: 'press', taps: 'tap', selects: 'select', chooses: 'choose', picks: 'pick', opens: 'open', navigates: 'navigate', goes: 'go', visits: 'visit', checks: 'check', ticks: 'tick', submits: 'submit', fills: 'fill', views: 'view', sees: 'see', shows: 'show', displays: 'display', redirects: 'redirect', logs: 'log', signs: 'sign', uploads: 'upload', searches: 'search', adds: 'add', removes: 'remove', proceeds: 'proceed', makes: 'make', pays: 'pay', places: 'place', receives: 'receive', confirms: 'confirm', sends: 'send', updates: 'update', cancels: 'cancel', registers: 'register', creates: 'create', saves: 'save', deletes: 'delete', edits: 'edit' };
  s = s.replace(/^(\w+)/, (w) => verbFix[w.toLowerCase()] ?? w);
  let m: RegExpMatchArray | null;

  if (system) {
    // Things the system does that a browser cannot see: e-mails and messages, and work behind the scenes.
    if (/^(?:send|emails?|notif(?:y|ies)|texts?|sms)\b/i.test(s) || /\b(?:e-?mail|sms|text message|push notification)\b/i.test(s) && !/\b(?:field|box)\b/i.test(s)) {
      notes.push(`"${sentence.trim()}" happens outside the website (an e-mail or message), so it cannot be checked in the browser. Check it by hand.`);
      return [];
    }
    if (/^(?:creates?|saves?|stores?|records?|updates?|reserves?|deducts?|charges?|process(?:es)?|calculates?|generates?|assigns?|logs?)\b/i.test(s)) {
      notes.push(`"${sentence.trim()}" happens inside the system. It is not a step; the checks that follow show whether it worked.`);
      return [];
    }
    if (/^confirm\s+(?:the\s+|that\s+)?(?:order|booking|purchase|payment|registration|request|submission|reservation)\b/i.test(s)) return [{ text: 'Verify a success message is displayed', role: 'verify' }];
  }
  if (system || /^(?:show|display|present|render|see|view|redirect|navigate|send|confirm|notify|validate|reject|prevent|keep|stay|remain)\b/i.test(s) && system) {
    if ((m = s.match(/^(?:redirect|navigate|take|send)s?(?:\s+(?:the\s+)?(?:user|them|customer))?\s+to\s+(.+)$/i))) return [{ text: `Verify the user is redirected to the ${stripArticle(m[1]).replace(/\s+page$/i, '')} page`, role: 'verify' }];
    if ((m = s.match(/^(?:show|display|present|render|see|view)s?\s+(.+)$/i))) {
      const what = m[1].trim();
      const quoted = what.match(/["“']([^"”']+)["”']/);
      if (/\b(?:error|invalid|validation|warning|failure|incorrect|wrong|not valid|rejected)\b/i.test(what)) return [{ text: quoted ? `Verify the error message "${quoted[1]}" is displayed` : 'Verify an error message is displayed', role: 'verify' }];
      if (quoted) return [{ text: `Verify "${quoted[1]}" is displayed`, role: 'verify' }];
      if (/\b(?:success|confirmation|saved|thank)\b/i.test(what) && /message|notice|banner/i.test(what)) return [{ text: 'Verify a success message is displayed', role: 'verify' }];
      const thing = stripArticle(what).replace(/\s+(?:page|screen)$/i, ' page');
      const plural = /[^s]s$/i.test(thing) && !/\b(?:details|status|address|news|progress)$/i.test(thing);
      return [{ text: `Verify the ${thing} ${plural ? 'are' : 'is'} displayed`.replace(/\bpage page\b/, 'page'), role: 'verify' }];
    }
    if ((m = s.match(/^(?:reject|prevent|block|deny|refuse)s?\b(.*)$/i))) return [{ text: 'Verify an error message is displayed', role: 'verify' }];
    return [{ text: `Verify ${s.charAt(0).toLowerCase()}${s.slice(1)}`, role: 'verify' }];
  }

  if ((m = s.match(/^(?:is|are)\s+(?:on|at|in)\s+(?:the\s+)?(.+)$/i))) return plan(`open ${m[1]}`, opts, first, notes);
  // Everyday shop and account actions, as use cases phrase them.
  if ((m = s.match(/^(?:log|sign)\s?in(?:\s+to\s+(?:the|his|her|their)?\s*(?:account|application|app|site|website|system))?\s+(?:with|using)\s+(?:his|her|their|the|a|valid|registered|correct)?\s*(.+)$/i))) {
    return [...plan(`enter ${m[1].replace(/\bcredentials?\b/i, 'email and password')}`, opts, false, notes), { text: 'Click the "Log in" button', role: 'submit' }];
  }
  if (/^(?:log|sign)\s?(?:out|off)\b/i.test(s)) return [{ text: 'Click "Log out"', role: 'other' }];
  if ((m = s.match(/^search(?:es)?\s+(?:for\s+)?(.+)$/i))) {
    const quoted = m[1].match(/["“']([^"”']+)["”']/);
    const value = quoted?.[1] ?? opts.testData?.search ?? opts.testData?.product;
    if (!value) notes.push(`"${sentence.trim()}": put the real text to search for in place of <${stripArticle(m[1])}>.`);
    return [{ text: `Search for "${value ?? `<${stripArticle(m[1])}>`}"`, role: 'other' }, { text: 'Press Enter', role: 'other' }];
  }
  if ((m = s.match(/^add\s+(?:it|them|this|that|(?:the|a|an|one)\s+(?:selected\s+)?[\w\s-]{1,30}?)?\s*to\s+(?:the\s+|his\s+|her\s+|their\s+)?(?:shopping\s+)?(cart|basket|bag|wish ?list)\b/i))) {
    const where = /wish/i.test(m[1]) ? 'wishlist' : m[1].toLowerCase();
    return [{ text: `Click the "Add to ${where}" button`, role: 'other' }];
  }
  if ((m = s.match(/^proceed\s+to\s+(?:the\s+)?(checkout|payment|cart|shipping|delivery)\b/i))) return [{ text: /checkout/i.test(m[1]) ? 'Click the "Checkout" button' : `Click the "Proceed to ${m[1].toLowerCase()}" button`, role: 'other' }];
  if (/^place\s+(?:the\s+|an?\s+|his\s+|her\s+|their\s+)?order\b/i.test(s)) return [{ text: 'Click the "Place order" button', role: 'submit' }];
  if (/^(?:make\s+(?:the\s+|a\s+)?payment|pay)\b/i.test(s)) return [{ text: 'Click the "Pay" button', role: 'submit' }];
  if ((m = s.match(/^receive\s+(.+)$/i))) {
    if (/\b(?:e-?mail|sms|text|message on (?:his|her|their) phone)\b/i.test(m[1])) {
      notes.push(`"${sentence.trim()}" happens outside the website (an e-mail or message), so it cannot be checked in the browser. Check it by hand.`);
      return [];
    }
    return [{ text: `Verify the ${stripArticle(m[1])} is displayed`, role: 'verify' }];
  }
  // "Selects a product", "chooses a payment method": the use case does not name it, so the step needs the real name.
  if ((m = s.match(/^(?:select|choose|pick)\s+(?:a|an|any|one|the|his|her|their)\s+([\w\s-]{2,40})$/i)) && !/\b(?:from|in)\b/i.test(m[1])) {
    const what = m[1].trim();
    notes.push(`"${sentence.trim()}": the use case does not say which ${what}. Replace <${what}> with the name shown on the page.`);
    return [{ text: `Click "<${what}>"`, role: 'other' }];
  }
  if ((m = s.match(/^(?:open|navigate to|go to|visit|launch|access)\s+(.+)$/i))) {
    const what = m[1];
    if (first && opts.startPage) return [{ text: `Open "${opts.startPage}"`, role: 'open' }];
    if (first || /\b(?:application|app|website|site|home ?page)\b/i.test(what)) return [{ text: 'Open the application', role: 'open' }];
    return [{ text: `Go to the ${stripArticle(what).replace(/\s+page$/i, '')} page`, role: 'open' }];
  }
  if ((m = s.match(/^(?:enter|type|input|provide|fill(?: in)?|key in|supply)\s+(.+)$/i))) {
    const parts = m[1].split(/\s*(?:,|\band\b)\s*/i).map((p) => p.trim()).filter(Boolean);
    return parts.map((p) => {
      const q = p.match(/^["“']([^"”']+)["”']\s+(?:in|into)\s+(?:the\s+)?(.+)$/i);
      const name = fieldLabel(q ? q[2] : p.replace(/\s+(?:in|into)\s+.*$/i, ''));
      const kind = kindOf(name);
      const value = q ? q[1] : (opts.testData?.[name.toLowerCase()] ?? GOOD[kind]);
      if (!q && !opts.testData?.[name.toLowerCase()] && (kind === 'email' || kind === 'password')) notes.push(`${name}: a sample value (${kind === 'password' ? 'hidden' : value}) is used. Replace it in the sheet with a real test account if the app needs one.`);
      return { text: `Enter "${value}" in the ${name} field`, field: { name, kind }, role: 'enter' as const };
    });
  }
  if ((m = s.match(/^(?:select|choose|pick)\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)$/i))) {
    const name = fieldLabel(m[2]);
    return [{ text: `Select "${stripArticle(m[1]).replace(/^["“']|["”']$/g, '')}" from the ${name} dropdown`, role: 'other' }];
  }
  if ((m = s.match(/^(?:check|tick|accept|agree to)\s+(?:the\s+)?(.+?)(?:\s+(?:checkbox|box))?$/i)) && !/^(?:that|if|whether)\b/i.test(m[1])) return [{ text: `Check the ${title(stripArticle(m[1]))} checkbox`, role: 'other' }];
  if ((m = s.match(/^(?:click|press|tap|hit|select|choose|submit)(?:\s+on)?\s+(?:the\s+)?(.+)$/i))) {
    const what = m[1].replace(/^["“']|["”']$/g, '');
    const hasHint = /\b(?:button|link|tab|icon|menu)$/i.test(what);
    const label = hasHint ? title(what.replace(/\s+(?:button|link|tab|icon|menu)$/i, '')) : title(what);
    const hint = hasHint ? what.match(/(button|link|tab|icon|menu)$/i)![1].toLowerCase() : '';
    const isSubmit = /^(?:submit|sign in|log ?in|save|register|sign up|create|pay|place order|checkout|continue|next|send|search|confirm|apply|update|add)\b/i.test(label);
    return [{ text: hint ? `Click the "${label}" ${hint}` : `Click "${label}"`, role: isSubmit ? 'submit' : 'other' }];
  }
  if ((m = s.match(/^(?:log|sign) ?in$/i))) return [{ text: 'Click "Log in"', role: 'submit' }];
  // Anything else would become a step nobody can run. Leave it out and say so, rather than fill the case with it.
  const asStep = s.charAt(0).toUpperCase() + s.slice(1);
  if (parseStep(asStep).action !== 'unknown') return [{ text: asStep, role: 'other' }];
  notes.push(`Could not turn "${sentence.trim()}" into a step, so it was left out. Add it by hand if it matters.`);
  return [];
}

export function generateCases(text: string, opts: GenerateOptions = {}): Generated {
  const uc = parseUseCase(text);
  const notes: string[] = [];
  const planned: Planned[] = [];
  uc.mainFlow.flatMap(splitCompound).forEach((sentence, i) => planned.push(...plan(sentence, opts, planned.length === 0 && i === 0, notes, uc.actor)));
  if (planned.length && planned[0].role !== 'open') planned.unshift({ text: opts.startPage ? `Open "${opts.startPage}"` : 'Open the application', role: 'open' });

  const cases: TestCase[] = [];
  let n = opts.firstNumber ?? 1;
  const source = `Use case: ${uc.title}`;
  const add = (c: Omit<TestCase, 'id' | 'source'>) => cases.push({ basis: 'stated', ...c, id: `TC-${String(n++).padStart(3, '0')}`, source });
  // Does the use case itself say something about this field? Used to tell stated expectations from guesses.
  const said = (field: string, re: RegExp) => [...uc.rules, ...uc.alternates, ...uc.preconditions].some((t) => re.test(t) && t.toLowerCase().includes(field.toLowerCase().split(' ')[0]));
  const REQUIRED = /\b(required|mandatory|must (?:not )?be (?:empty|blank|provided|entered)|cannot be (?:empty|blank)|can't be (?:empty|blank)|is needed|blank|empty|missing)\b/i;
  const FORMAT = /\b(valid|invalid|format|well-formed|malformed)\b/i;

  const lastSubmit = planned.map((p) => p.role).lastIndexOf('submit');
  const outcomeStart = lastSubmit >= 0 ? lastSubmit + 1 : planned.length;
  const outcome = planned.slice(outcomeStart).filter((p) => p.role === 'verify');
  const expectedText = (uc.postconditions[0] ?? '').trim() || (outcome.length ? outcome.map((o) => o.text.replace(/^Verify\s+/i, '')).join('; ') : 'The flow completes successfully');
  const preconditions = [...uc.preconditions, ...(uc.actor ? [`Actor: ${uc.actor}`] : [])].join('; ') || undefined;
  const fields = planned.filter((p) => p.field);
  const stepsOf = (list: Planned[]) => list.map((p) => p.text);

  if (!planned.length) notes.push('No steps were found in the main flow. Add a "Main flow:" section with numbered steps.');

  // 1. The happy path.
  if (planned.length) add({ title: `${uc.title}: main flow succeeds`, type: 'Positive', priority: 'High', basis: 'stated', preconditions, steps: stepsOf(planned), expected: expectedText });

  // Replace the value typed into one field and cut the outcome checks off, ending in an error check.
  const withValue = (field: string, value: string | null, _why: string, extra?: Planned[]): Planned[] => {
    const out = planned.slice(0, outcomeStart).map((p) => {
      if (p.field?.name !== field) return p;
      return value === null ? { ...p, text: `Leave the ${field} field empty` } : { ...p, text: `Enter ${JSON.stringify(value)} in the ${field} field` };
    });
    return [...out, ...(extra ?? [{ text: 'Verify an error message is displayed', role: 'verify' as const }])];
  };
  const errorExpected = 'An error or validation message is shown and the flow does not complete';

  // 2. Per field: empty, invalid format, too long, special characters.
  const seen = new Set<string>();
  for (const f of fields) {
    const name = f.field!.name;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const kind = f.field!.kind;
    add({ title: `${uc.title}: ${name} left empty`, type: 'Negative', priority: said(name, REQUIRED) ? 'High' : 'Low', basis: said(name, REQUIRED) ? 'stated' : 'assumed', preconditions, steps: stepsOf(withValue(name, null, 'empty')), expected: errorExpected });
    const bad = BAD[kind];
    if (bad) add({ title: `${uc.title}: ${bad[1]} in ${name}`, type: 'Negative', priority: 'Medium', basis: said(name, FORMAT) ? 'stated' : 'assumed', preconditions, steps: stepsOf(withValue(name, bad[0], bad[1])), expected: errorExpected });
    if (kind === 'text' || kind === 'email') {
      add({ title: `${uc.title}: very long ${name} (300 characters)`, type: 'Boundary', priority: 'Low', basis: 'assumed', preconditions, steps: stepsOf(withValue(name, kind === 'email' ? 'a'.repeat(290) + '@example.com' : 'a'.repeat(300), 'long')), expected: errorExpected });
    }
    if (kind === 'text') {
      add({ title: `${uc.title}: special characters in ${name}`, type: 'Edge', priority: 'Low', basis: 'assumed', preconditions, steps: stepsOf(withValue(name, `<script>alert(1)</script> ' OR '1'='1`, 'special', [{ text: 'Verify no error message is shown', role: 'verify' }])), expected: 'The text is handled as plain text: no script runs and the page does not break' });
    }
  }

  // 3. Business rules with numbers become boundary cases.
  const textFields = fields.map((f) => f.field!);
  for (const rule of uc.rules) {
    const target = textFields.find((f) => new RegExp(f.name.split(' ')[0], 'i').test(rule)) ?? (textFields.length === 1 ? textFields[0] : undefined);
    const min = rule.match(/(?:at least|minimum(?: of)?|min\.?|no (?:fewer|less) than)\s+(\d+)\s+(?:characters?|chars?|letters?|digits?)/i);
    const max = rule.match(/(?:at most|maximum(?: of)?|max\.?|no more than|up to|not exceed|must not exceed)\s+(\d+)\s+(?:characters?|chars?)/i);
    const range = rule.match(/between\s+(\d+)\s+and\s+(\d+)/i);
    const fill = (len: number, kind: Kind) => (kind === 'password' ? ('Aa1!' + 'a'.repeat(Math.max(0, len))).slice(0, Math.max(len, 0)) : 'a'.repeat(Math.max(len, 0)));
    if (target && min) {
      const k = Number(min[1]);
      add({ title: `${uc.title}: ${target.name} one character too short (${k - 1})`, type: 'Boundary', priority: 'Medium', preconditions, steps: stepsOf(withValue(target.name, fill(k - 1, target.kind), 'min-1')), expected: errorExpected });
      if (target.kind === 'password') notes.push(`The ${target.name} rule needs a real account whose password is exactly ${k} characters to test the lowest allowed value. Add that case by hand with the right test data.`);
      else add({ title: `${uc.title}: ${target.name} exactly ${k} characters`, type: 'Boundary', priority: 'Medium', preconditions, steps: stepsOf([...planned.slice(0, outcomeStart).map((p) => (p.field?.name === target.name ? { ...p, text: `Enter "${fill(k, target.kind)}" in the ${target.name} field` } : p)), ...planned.slice(outcomeStart)]), expected: expectedText });
    } else if (target && max) {
      const k = Number(max[1]);
      add({ title: `${uc.title}: ${target.name} exactly ${k} characters`, type: 'Boundary', priority: 'Medium', preconditions, steps: stepsOf([...planned.slice(0, outcomeStart).map((p) => (p.field?.name === target.name ? { ...p, text: `Enter "${fill(k, target.kind)}" in the ${target.name} field` } : p)), ...planned.slice(outcomeStart)]), expected: expectedText });
      add({ title: `${uc.title}: ${target.name} one character too long (${k + 1})`, type: 'Boundary', priority: 'Medium', preconditions, steps: stepsOf(withValue(target.name, fill(k + 1, target.kind), 'max+1')), expected: errorExpected });
    } else if (target && range) {
      const [lo, hi] = [Number(range[1]), Number(range[2])];
      for (const [v, ok] of [[lo - 1, false], [lo, true], [hi, true], [hi + 1, false]] as [number, boolean][]) {
        add({
          title: `${uc.title}: ${target.name} = ${v} (${ok ? 'allowed' : 'outside the range'})`, type: 'Boundary', priority: 'Medium', preconditions,
          steps: stepsOf(ok ? [...planned.slice(0, outcomeStart).map((p) => (p.field?.name === target.name ? { ...p, text: `Enter "${v}" in the ${target.name} field` } : p)), ...planned.slice(outcomeStart)] : withValue(target.name, String(v), 'range')),
          expected: ok ? expectedText : errorExpected,
        });
      }
    } else {
      // "must be a valid email" and the like are already covered by the invalid-format case of each field.
      if (!/\b(valid|format|well-formed|correct)\b/i.test(rule)) notes.push(`Rule not turned into a test: "${rule}". Add a case for it by hand, or use the AI option.`);
    }
  }

  // 4. Alternate flows.
  for (const alt of uc.alternates) {
    const label = alt.replace(/^[A-Za-z]?\d+[a-z]?[.):]\s*/, '');
    const name = label.split(/[:.-]\s+/)[0].trim();
    const quoted = label.match(/["“']([^"”']{3,})["”']/);
    const field = textFields.find((f) => new RegExp(f.name.split(' ')[0], 'i').test(label));
    const expected = quoted ? `The message "${quoted[1]}" is shown` : errorExpected;
    const finish: Planned[] = [quoted ? { text: `Verify "${quoted[1]}" is displayed`, role: 'verify' } : { text: 'Verify an error message is displayed', role: 'verify' }];
    if (field && /\b(?:empty|blank|missing|required|not provided|omit|without)\b/i.test(label)) {
      add({ title: `${uc.title}: ${name}`, type: 'Alternate', priority: 'Medium', preconditions, steps: stepsOf(withValue(field.name, null, 'alt', finish)), expected });
    } else if (field && /\b(?:wrong|invalid|incorrect|bad|malformed|not valid|mismatch|expired|too short|too long)\b/i.test(label)) {
      const value = field.kind === 'password' ? 'WrongPassword9!' : (BAD[field.kind]?.[0] ?? 'invalid value');
      add({ title: `${uc.title}: ${name}`, type: 'Alternate', priority: 'Medium', preconditions, steps: stepsOf(withValue(field.name, value, 'alt', finish)), expected });
    } else if (field && /\b(?:not registered|unregistered|does not exist|unknown|no account|not found|new user)\b/i.test(label) && field.kind === 'email') {
      add({ title: `${uc.title}: ${name}`, type: 'Alternate', priority: 'Medium', preconditions, steps: stepsOf(withValue(field.name, 'nobody-here@example.com', 'alt', finish)), expected });
    } else {
      add({ title: `${uc.title}: ${name}`, type: 'Alternate', priority: 'Medium', preconditions: [preconditions, `Condition: ${label}`].filter(Boolean).join('; '), steps: stepsOf([...planned.slice(0, outcomeStart), ...finish]), expected });
      notes.push(`Alternate flow "${label}": the steps repeat the main flow. Set up the condition it describes (in the preconditions or the steps) before running it.`);
    }
  }

  // 5. Given / When / Then scenarios.
  for (const sc of uc.scenarios) {
    const steps: string[] = [];
    let first = true;
    for (const w of [...sc.given, ...sc.when].flatMap(splitCompound)) {
      for (const p of plan(w, opts, first, notes, uc.actor)) steps.push(p.text);
      first = false;
    }
    if (steps.length && !/^open/i.test(steps[0])) steps.unshift(opts.startPage ? `Open "${opts.startPage}"` : 'Open the application');
    for (const t of sc.then) steps.push(...plan(`system shows ${t.replace(/^(?:the\s+)?system\s+(?:shows|displays)\s+/i, '')}`, opts, false, notes).map((p) => p.text));
    add({ title: `${uc.title}: ${sc.name}`, type: 'Acceptance', priority: 'High', preconditions: sc.given.join('; ') || preconditions, steps, expected: sc.then.join('; ') });
  }

  const guessed = cases.filter((c) => c.basis === 'assumed').length;
  if (guessed) notes.push(`${guessed} case${guessed === 1 ? ' rests' : 's rest'} on assumptions: the use case does not say whether those fields are required or limited, so what should happen is a guess. They are marked "Assumed" in the sheet. If the app behaves differently and that is fine, change the last step or delete the case.`);
  const unique = [...new Set(notes)];
  return { cases, notes: unique, useCase: uc, analysis: analyse(uc, cases, unique) };
}
