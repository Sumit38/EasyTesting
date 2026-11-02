/** A test case written in plain English, and how it maps to and from a spreadsheet. */

export interface TestCase {
  id: string;
  /** The test case name. */
  title: string;
  /** The scenario the case belongs to, for example "Login - Field validation: Email". */
  scenario?: string;
  area?: string;
  /** Which kind of requirement the case covers. */
  category?: Category;
  /** A check a person does by hand (uptime, browsers, account lockout): in the sheet, but not run by the tool. */
  manual?: boolean;
  priority?: string;
  /** Positive, Negative, Boundary, Edge... */
  type?: string;
  preconditions?: string;
  /** One plain-English instruction per entry. */
  steps: string[];
  /** The overall result the tester expects. */
  expected: string;
  /** Where the case came from, for example the use case it was generated from. */
  source?: string;
  /** 'stated' when the use case says what should happen; 'assumed' when the generator had to guess the expectation. */
  basis?: 'stated' | 'assumed';
}

export type Category = 'Functional' | 'Field validation' | 'Non-functional';
export const CATEGORIES: Category[] = ['Functional', 'Field validation', 'Non-functional'];

export const FIELDS = ['id', 'scenario', 'title', 'area', 'priority', 'type', 'category', 'preconditions', 'steps', 'expected', 'manual', 'basis'] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Record<Field, number>;

/** The columns of the sheets this tool writes. Reading them back needs no mapping. */
export const HEADER = ['Test Case ID', 'Scenario Name', 'Test Case Name', 'Precondition', 'Test Case Steps', 'Expected Results', 'Requirement Type', 'Test Type', 'Priority', 'Execution', 'Basis'];
export const COLUMN_WIDTHS = [13, 34, 44, 32, 70, 46, 17, 12, 10, 11, 10];

const PATTERNS: Record<Field, RegExp> = {
  id: /^(id|tc ?id|test ?case ?id|case ?id|test ?id|no\.?|#|ref(erence)?)$/i,
  title: /^(title|test ?case( name| title| description| desc| summary| scenario)?|test ?(scenario|name|title|description|objective|summary)( name| description)?|scenario( name| description)?|name|summary|case|description|objective)$/i,
  scenario: /^(?:test\s*)?scenarios?(?:\s*(?:name|title|description))?$|^feature$|^user ?story$/i,
  category: /^(?:requirement|req\.?)\s*(?:type|category|kind)$|^test ?category$|^requirement$/i,
  manual: /^(?:execution(?:\s*type)?|automation(?:\s*status)?|automated\??|manual\s*\/\s*automated|automated\s*\/\s*manual|run mode|how to run)$/i,
  area: /^(area|module|feature|component|page|section|screen|functionality)$/i,
  priority: /^(priority|severity|risk|criticality)$/i,
  type: /^(type|category|kind|test ?type|case ?type)$/i,
  preconditions: /^(pre-?conditions?|prerequisites?|pre-?requisites?|setup|given|assumptions?)$/i,
  steps: /^(steps?|test ?steps?|test ?case ?steps?|procedure|test procedure|actions?|how to test|execution steps?|step ?description|steps? to (reproduce|follow|execute)|test ?steps? description)$/i,
  expected: /^(expected( result| outcome| behaviou?r)?s?|result|outcome|expected ?results?|acceptance|then)$/i,
  basis: /^(basis|expectation basis|basis of expectation|assumed|assumption|rationale)$/i,
};

/** Guesses which column holds which field from the header row. -1 means not found. */
export function detectMapping(header: string[]): Mapping {
  const mapping = Object.fromEntries(FIELDS.map((f) => [f, -1])) as Mapping;
  const taken = new Set<number>();
  // The test case's own name first: in "Scenario Name | Test Case Name" the scenario is not the title.
  const name = header.findIndex((h) => /^(?:test ?case ?(?:name|title)|case ?name|test ?(?:name|title)|title|name)$/i.test(h.trim()));
  if (name !== -1) {
    mapping.title = name;
    taken.add(name);
  }
  // Title before scenario: a lone "Test Scenario" column is the name of each case.
  for (const field of [...FIELDS.filter((f) => f !== 'scenario'), 'scenario' as const]) {
    if (field === 'title' && name !== -1) continue;
    const i = header.findIndex((h, idx) => !taken.has(idx) && PATTERNS[field].test(h.trim()));
    if (i !== -1) {
      mapping[field] = i;
      taken.add(i);
    }
  }
  return mapping;
}

/** True when the first row looks like a header rather than a test case. */
export function hasHeaderRow(rows: string[][]): boolean {
  if (!rows.length) return false;
  const m = detectMapping(rows[0]);
  return m.steps !== -1 || m.title !== -1 || m.id !== -1;
}

/** Splits a cell of steps into separate steps: one per line, with numbering ("1.", "1)", "Step 1:", bullets) removed. */
export function splitSteps(cell: string): string[] {
  const lines = cell.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const stripped = lines.map((l) => l.replace(/^(?:step\s*)?\d+\s*[.):\-]\s*/i, '').replace(/^[-*•]\s+/, '').trim()).filter(Boolean);
  // A single line holding "1. a 2. b 3. c" is one cell typed without line breaks.
  if (stripped.length === 1 && /\b2[.)]\s/.test(lines[0]) && /^\s*(?:step\s*)?1[.)]/i.test(lines[0])) {
    return lines[0].split(/\s*(?:step\s*)?\d+[.)]\s+/i).map((s) => s.trim()).filter(Boolean);
  }
  return stripped;
}

/**
 * Builds test cases from sheet rows using a column mapping. Rows with an empty ID directly under a case add
 * steps to it (the one-row-per-step layout). Rows with no steps and no title are skipped.
 */
export function rowsToCases(rows: string[][], mapping: Mapping, skipHeader: boolean): { cases: TestCase[]; warnings: string[] } {
  const cases: TestCase[] = [];
  const warnings: string[] = [];
  const get = (r: string[], f: Field) => (mapping[f] >= 0 ? (r[mapping[f]] ?? '').trim() : '');
  const used = new Set<string>();
  let current: TestCase | undefined;
  rows.slice(skipHeader ? 1 : 0).forEach((r, i) => {
    const id = get(r, 'id');
    const title = get(r, 'title');
    const steps = splitSteps(get(r, 'steps'));
    const expected = get(r, 'expected');
    if (!id && !title && !steps.length && !expected) return;
    // Continuation row: no id, no title, just another step (and maybe its expected result).
    if (!id && !title && current && (steps.length || expected)) {
      current.steps.push(...steps);
      if (expected) current.expected = current.expected ? `${current.expected}; ${expected}` : expected;
      return;
    }
    let finalId = id || `TC-${String(cases.length + 1).padStart(3, '0')}`;
    if (used.has(finalId.toLowerCase())) {
      // Same id on a row that has its own title and steps: a duplicate. Keep both, but make the id unique.
      warnings.push(`Row ${i + 2}: the id ${finalId} is used twice. The second one was renamed.`);
      let n = 2;
      while (used.has(`${finalId}-${n}`.toLowerCase())) n++;
      finalId = `${finalId}-${n}`;
    }
    used.add(finalId.toLowerCase());
    current = {
      id: finalId, title: title || finalId, scenario: get(r, 'scenario') || undefined, area: get(r, 'area') || undefined,
      category: CATEGORIES.find((c) => c.toLowerCase() === get(r, 'category').toLowerCase().replace(/^nfr$|^non ?functional$/, 'non-functional').replace(/^validation$/, 'field validation')),
      manual: /^(?:manual|no|by hand|not automated)$/i.test(get(r, 'manual')) || undefined, priority: get(r, 'priority') || undefined, type: get(r, 'type') || undefined,
      preconditions: get(r, 'preconditions') || undefined, steps, expected, basis: /assum/i.test(get(r, 'basis')) ? 'assumed' : /stated|given|spec/i.test(get(r, 'basis')) ? 'stated' : undefined,
    };
    cases.push(current);
  });
  for (const c of cases) if (!c.steps.length) warnings.push(`${c.id} has no steps, so it cannot be run.`);
  return { cases, warnings };
}

/** The sheet this tool writes: a header plus one row per case, steps numbered in one cell. */
export function casesToRows(cases: TestCase[]): string[][] {
  return [
    HEADER,
    ...cases.map((c) => [
      c.id, c.scenario ?? c.area ?? '', c.title, c.preconditions ?? '', c.steps.map((s, i) => `${i + 1}. ${s}`).join('\n'), c.expected,
      c.category ?? '', c.type ?? '', c.priority ?? '', c.manual ? 'Manual' : 'Automated', c.basis === 'assumed' ? 'Assumed' : c.basis === 'stated' ? 'Stated' : '',
    ]),
  ];
}
