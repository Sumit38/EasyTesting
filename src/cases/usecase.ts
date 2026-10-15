/** Reads a use case written in ordinary prose into the parts a test designer needs. */

export interface UseCase {
  title: string;
  actor?: string;
  preconditions: string[];
  mainFlow: string[];
  alternates: string[];
  rules: string[];
  postconditions: string[];
  /** Given / When / Then scenarios from acceptance criteria. */
  scenarios: { name: string; given: string[]; when: string[]; then: string[] }[];
}

type Section = 'title' | 'actor' | 'pre' | 'main' | 'alt' | 'rules' | 'post' | 'accept' | 'description' | 'skip';

const HEADINGS: [RegExp, Section][] = [
  // Document details and sections that describe the use case rather than what to do in the app.
  [/^(?:use ?case\s+)?(?:id|no\.?|number|#|ref(?:erence)?|version|author|owner|prepared by|reviewed by|approved by|date|created(?: on| by)?|last (?:updated|modified)|revision(?: history)?|status|level|scope|priority|frequency(?: of use)?|stakeholders?(?: and interests)?|secondary actors?|supporting actors?|other actors?|trigger|triggers|includes|extends|related use cases?|references?|glossary|notes?|open issues|issues|special requirements|non-functional requirements|technology(?: and data)? variations|document (?:id|version|title|history|control|information)|table of contents|contents|change log|sign-?off|approvals?)\b\s*(?:[:\-–]\s*(.*))?$/i, 'skip'],
  [/^(?:use ?case|uc|user story|story|feature|scenario)\b[\s\w#.-]*?[:\-–]\s*(.*)$/i, 'title'],
  [/^(?:primary\s+|main\s+)?actors?\s*[:\-–]\s*(.*)$/i, 'actor'],
  [/^(?:as an?|as the)\s+(.+?)(?:,|\s+i\s+(?:want|can|need|would))/i, 'actor'],
  [/^pre-?conditions?\s*[:\-–]?\s*(.*)$/i, 'pre'],
  [/^(?:prerequisites?|assumptions?)\s*[:\-–]?\s*(.*)$/i, 'pre'],
  [/^(?:main|basic|normal|happy|primary|success)(?:\s+success)?(?:\s+(?:flow|scenario|path|course))?(?:\s+of events)?\s*[:\-–]?\s*(.*)$/i, 'main'],
  [/^(?:steps?|flow(?: of events)?|procedure|description of flow)\s*[:\-–]?\s*(.*)$/i, 'main'],
  [/^(?:alternate|alternative|alt|exception|exceptional|extension|error|failure|negative)s?(?:\s+(?:flows?|scenarios?|paths?|courses?|cases?))?\s*[:\-–]?\s*(.*)$/i, 'alt'],
  [/^(?:business\s+)?(?:rules?|constraints?|validations?|validation rules?|requirements?|non-functional)\s*[:\-–]?\s*(.*)$/i, 'rules'],
  [/^(?:post-?conditions?|outcome|expected(?: result)?|success (?:guarantee|criteria)|result)\s*[:\-–]?\s*(.*)$/i, 'post'],
  [/^(?:acceptance criteria|acceptance tests?|criteria)\s*[:\-–]?\s*(.*)$/i, 'accept'],
  [/^(?:description|summary|overview|goal|purpose)\s*[:\-–]?\s*(.*)$/i, 'description'],
];

const ITEM = /^\s*(?:(?:step\s*)?\d+[a-z]?[.):]|step\s*\d+[a-z]?\s*[-–]|\d+[a-z]?\s+[-–]|[a-z]\d+[.):]|\d+(?:\.\d+)+[.)]?|[-*•–]|[a-z][.)])\s+/i;

/** "1. Open the site. 2. Click Login. 3. ..." typed as one line: one item per number. */
function splitInline(item: string): string[] {
  if (!/(?:^|\s)2[.)]\s/.test(item) || !/(?:^|\s)1[.)]\s|^[^0-9]/.test(item)) return [item];
  const parts = item.split(/\s+(?=\d{1,2}[.)]\s)/).map((p) => p.replace(ITEM, '').trim()).filter(Boolean);
  return parts.length > 1 ? parts : [item];
}

/** Titles that say what the document is, not what it is about. */
const GENERIC_TITLE = /^(?:(?:professional|detailed|full|complete|sample)\s+)?(?:use ?case|requirements?|functional)\s+(?:document|specification|spec|template|description)$/i;

const COLUMN_NAME = /^(?:#|no\.?|s\.? ?no\.?|sr\.? ?no\.?|step(?:\s*(?:no\.?|#|number))?|actor|who|action|actions|user action|actor action|system response|response|system|description|step description|expected(?: result)?|result|remarks?|notes?)$/i;

/**
 * The steps in one row of a flow table, or undefined when the row is not one ("Version | 1.0").
 * "1 | Customer | Opens the site" becomes "Customer opens the site"; "The user clicks Save | The system shows Saved" becomes both.
 */
function rowSteps(cells: string[]): string[] | undefined {
  if (cells.length >= 2 && cells.every((c) => COLUMN_NAME.test(c.trim()))) return []; // the header row
  let rest = cells.map((c) => c.trim()).filter(Boolean);
  if (/^(?:step\s*)?\d+[a-z]?[.)]?$/i.test(rest[0] ?? '')) rest = rest.slice(1);
  if (rest.length >= 2 && rest[0].split(/\s+/).length <= 3 && !looksLikeStep(rest[0]) && /^[a-z]/i.test(rest[1])) {
    const action = rest[1].charAt(0).toLowerCase() + rest[1].slice(1);
    const joined = `${/^(?:the|a|an)\s/i.test(rest[0]) ? rest[0] : 'The ' + rest[0].toLowerCase()} ${action}`;
    if (looksLikeStep(joined)) return [joined, ...rest.slice(2).filter(looksLikeStep)];
  }
  const steps = rest.filter(looksLikeStep);
  return steps.length && cells.length >= 2 ? steps : undefined;
}

/** Plain text from Markdown, Word or a sheet: headings without #, table rows as "Name: value", no bold or code marks. */
function plainLines(text: string): { line: string; heading: boolean }[] {
  const out: { line: string; heading: boolean }[] = [];
  const unmark = (s: string) => s.replace(/\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g, (_, a, b, c) => a ?? b ?? c).replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$|[.,:;])/g, '$1$2').trim();
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    let l = raw.trim();
    if (!l || /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(l) || /^(?:-{3,}|\*{3,}|_{3,}|={3,})$/.test(l)) continue; // table rules and dividers
    const dashed = l.split(/\s+-\s+/);
    if (dashed.length >= 2 && dashed.every((c) => COLUMN_NAME.test(c.trim()))) continue; // "Step - Actor - Action": the heading row of a sheet
    // A table row: from Markdown ("| 1 | Customer | Opens the site |") or a sheet read as text ("1 - Customer - Opens the site").
    const cells = /^\|.*\|$/.test(l) ? l.slice(1, -1).split('|').map(unmark).filter(Boolean)
      : raw.includes('\t') && raw.trim().split(/\t+/).length >= 2 ? raw.trim().split(/\t+/).map(unmark).filter(Boolean) // copied from Excel or Word tables
      : /^(?:step\s*)?\d+[a-z]?[.)]?\s+-\s+.+\s+-\s+/i.test(l) ? l.split(/\s+-\s+/).map(unmark) : undefined;
    if (cells) {
      const steps = rowSteps(cells);
      if (steps) {
        for (const s of steps) out.push({ line: s, heading: false });
        continue;
      }
      // A two-column "field | value" table becomes "Field: value"; its header row ("Field | Details") says nothing.
      if (/^\|/.test(l) || raw.includes('\t')) {
        if (cells.length === 2 && /^(?:field|attribute|item|property|name|section|key)$/i.test(cells[0]) && /^(?:details?|value|description|information|content)$/i.test(cells[1])) continue;
        out.push({ line: cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join(' - '), heading: false });
        continue;
      }
    }
    const heading = /^#{1,6}\s/.test(l);
    l = unmark(l.replace(/^#{1,6}\s+/, '').replace(/^>\s*/, ''));
    if (l) out.push({ line: l, heading });
  }
  return out;
}

export function parseUseCase(text: string): UseCase {
  const uc: UseCase = { title: '', preconditions: [], mainFlow: [], alternates: [], rules: [], postconditions: [], scenarios: [] };
  const plain = plainLines(text);
  const lines = plain.map((p) => p.line);
  const firstHeading = plain.find((p) => p.heading && !GENERIC_TITLE.test(p.line.replace(ITEM, '')) && !HEADINGS.some(([re]) => re.test(p.line.replace(ITEM, ''))))?.line;
  let section: Section | undefined;
  const loose: string[] = [];
  let gwt: UseCase['scenarios'][number] | undefined;
  let gwtPart: 'given' | 'when' | 'then' = 'given';

  const push = (to: Section | undefined, item: string) => {
    const pieces = to === 'main' || to === 'alt' || to === 'pre' || to === 'post' ? splitInline(item) : [item];
    if (pieces.length > 1) return pieces.forEach((p) => push(to, p));
    const t = item.trim();
    if (!t) return;
    if (to === 'pre') uc.preconditions.push(t);
    else if (to === 'main') uc.mainFlow.push(t);
    else if (to === 'alt') uc.alternates.push(t);
    else if (to === 'rules') uc.rules.push(t);
    else if (to === 'post') uc.postconditions.push(t);
    else if (to === 'actor' && !uc.actor) uc.actor = t;
    else loose.push(t);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Given / When / Then
    const g = line.match(/^(given|when|then|and|but)\b[\s:,-]*(.*)$/i);
    if (g && (section === 'accept' || gwt || /^(given|when|then)\b/i.test(line))) {
      const kw = g[1].toLowerCase();
      if (kw === 'given' && (!gwt || gwt.when.length || gwt.then.length)) {
        gwt = { name: `Scenario ${uc.scenarios.length + 1}`, given: [], when: [], then: [] };
        uc.scenarios.push(gwt);
      }
      if (!gwt) {
        gwt = { name: `Scenario ${uc.scenarios.length + 1}`, given: [], when: [], then: [] };
        uc.scenarios.push(gwt);
      }
      if (kw === 'given' || kw === 'when' || kw === 'then') gwtPart = kw;
      gwt[gwtPart].push(g[2].trim());
      continue;
    }
    const named = line.match(/^scenario\s*:?\s*(.+)$/i);
    if (named && section === 'accept') {
      gwt = { name: named[1].trim(), given: [], when: [], then: [] };
      uc.scenarios.push(gwt);
      gwtPart = 'given';
      continue;
    }

    // A heading, possibly with content after the colon.
    let matched = false;
    for (const [re, kind] of HEADINGS) {
      const h = line.replace(ITEM, '').match(re);
      // Headings are short lines; a long sentence that happens to start with "main" is content. A numbered line is a heading
      // ("4. Main Flow") only when nothing follows the heading word; "2. Basic details are saved" is a step.
      if (h && (line.endsWith(':') || line.length < 70 || h[1] !== undefined) && !(ITEM.test(line) && kind !== 'title' && kind !== 'actor' && !line.endsWith(':') && (h[1] ?? '').trim())) {
        matched = true;
        if (kind === 'skip') {
          section = 'skip';
        } else if (kind === 'title') {
          if (!uc.title) uc.title = (h[1] || '').trim();
          section = 'title';
        } else if (kind === 'actor' && re.source.startsWith('^(?:as')) {
          uc.actor = uc.actor ?? h[1].trim();
          loose.push(line);
        } else {
          section = kind;
          if (h[1]?.trim()) push(kind === 'accept' || kind === 'description' ? undefined : kind, h[1]);
          if (kind === 'accept') gwt = undefined;
        }
        break;
      }
    }
    if (matched) continue;
    if (section === 'skip') continue;
    push(section, line.replace(ITEM, ''));
  }

  if (!uc.title) uc.title = (firstHeading ?? loose.find((l) => !GENERIC_TITLE.test(l)) ?? uc.mainFlow[0] ?? 'Use case').replace(ITEM, '').replace(/\s*[-–]\s*use ?case$/i, '').replace(/[.:]+$/, '').slice(0, 80);
  // No flow heading at all: the sentences that describe someone doing something are the main flow. Titles, headings and
  // descriptions of the document are not steps.
  if (!uc.mainFlow.length && !uc.scenarios.length) {
    const sentences = (loose.length ? loose : lines).flatMap((l) => l.split(/(?<=[.;])\s+/)).map((s) => s.replace(ITEM, '').replace(/[.;]$/, '').trim()).filter(Boolean);
    uc.mainFlow = sentences.filter((s) => s !== uc.title && looksLikeStep(s));
  }
  return uc;
}

const DOER = '(?:user|customer|shopper|buyer|visitor|member|client|admin(?:istrator)?|tester|guest|patient|student|employee|manager|agent|operator|actor|system|application|app|site|website|page|he|she|they|i|we)';
const DOING = '(?:opens?|navigates?|goes|visits?|launch(?:es)?|logs?|signs?|enters?|types?|inputs?|fills?|provides?|clicks?|taps?|press(?:es)?|selects?|chooses?|picks?|adds?|removes?|search(?:es)?|submits?|pays?|places?|proceeds?|checks? ?out|uploads?|downloads?|views?|sees?|displays?|shows?|redirects?|receives?|confirms?|updates?|edits?|deletes?|cancels?|registers?|creates?|saves?|verif(?:y|ies)|validates?|rejects?|accepts?|agrees?|makes?)';
/** "The customer adds the item to the cart", "Click Save": a line someone does, not a title or a description of the document. */
export function looksLikeStep(s: string): boolean {
  if (s.split(/\s+/).length > 40) return false;
  return new RegExp(`^(?:(?:the|a|an|then|and|next|finally)\\s+)*(?:[\\w-]+\\s+){0,2}?${DOER}\\s+(?:(?:then|also|can|should|will|must|may)\\s+)*${DOING}\\b`, 'i').test(s)
    || new RegExp(`^(?:then\\s+)?${DO_NOW}\\b`, 'i').test(s);
}
/** The same actions as an instruction: "Open the site", "Add the item to the cart". */
const DO_NOW = '(?:open|navigate|go|visit|launch|log|sign|enter|type|input|fill|provide|click|tap|press|select|choose|pick|add|remove|search|submit|pay|place|proceed|check ?out|upload|download|view|see|verify|validate|confirm|update|edit|delete|cancel|register|create|save|wait|scroll|refresh|hover)';
