/**
 * Reads one plain-English test step into an action. This is a rule-based reader for the phrasing testers
 * normally use (and the phrasing this tool generates). It reports how sure it is, and says so when it is not,
 * so a person can correct the step before anything runs.
 */

export type Action = 'open' | 'click' | 'type' | 'clear' | 'select' | 'check' | 'uncheck' | 'hover' | 'press' | 'wait' | 'verify' | 'refresh' | 'back' | 'scroll' | 'unknown';
export type Check = 'visible' | 'hidden' | 'no-text' | 'enabled' | 'disabled' | 'checked' | 'unchecked' | 'text' | 'title' | 'url' | 'page' | 'value' | 'message' | 'no-message' | 'readonly' | 'editable';

export interface ParsedStep {
  raw: string;
  action: Action;
  /** The words naming the element, without articles or the control type: "Email", "Sign in". */
  target?: string;
  /** What kind of control the tester called it: button, link, field, checkbox, dropdown... */
  hint?: string;
  /** Text to type, option to choose, URL to open, key to press, milliseconds to wait, or text to expect. */
  value?: string;
  check?: Check;
  /** For title and URL checks: require an exact match rather than "contains". */
  exact?: boolean;
  /** For message checks: error, success, warning. */
  kind?: string;
  /** 0 to 1: how sure the reading is. Under 0.6 a person should look at it. */
  confidence: number;
  /** A field to fill was named but no text to put in it ("Enter valid password"): it cannot run until the text is added. */
  needsValue?: boolean;
  notes: string[];
}

const QUOTE = `(?:"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’)`;
const q = (m: RegExpMatchArray, from: number) => [m[from], m[from + 1], m[from + 2], m[from + 3]].find((x) => x !== undefined);

const HINTS: Record<string, string> = {
  button: 'button', btn: 'button', link: 'link', hyperlink: 'link', field: 'field', box: 'field', textbox: 'field', 'text box': 'field', 'text field': 'field', input: 'field', 'input field': 'field', textarea: 'field',
  checkbox: 'checkbox', 'check box': 'checkbox', 'radio button': 'radio', radio: 'radio', dropdown: 'dropdown', 'drop-down': 'dropdown', 'drop down': 'dropdown', list: 'dropdown', menu: 'menu', 'menu item': 'menuitem',
  tab: 'tab', icon: 'icon', option: 'option', toggle: 'switch', switch: 'switch', label: 'label', heading: 'heading', header: 'heading', title: 'heading', page: 'page', section: 'section', image: 'image', message: 'message', banner: 'message',
};
const HINT_ALTERNATION = Object.keys(HINTS).sort((a, b) => b.length - a.length).join('|');

/** Example data for descriptions like "a valid email". Used only when the step gives no exact text. */
const DATA: [RegExp, string, string][] = [
  [/^(?:a\s+|an\s+|the\s+)?(?:valid|correct|registered|existing)\s+e-?mail(?:\s+address)?$/i, 'tester@example.com', 'a valid email'],
  [/^(?:an?\s+|the\s+)?(?:invalid|incorrect|malformed|wrong)\s+e-?mail(?:\s+address)?$/i, 'not-an-email', 'an invalid email'],
  [/^(?:an?\s+|the\s+)?(?:invalid|incorrect|wrong|random)\s+password$/i, 'Wrong-Pass-123', 'a wrong password'],
  [/^(?:an?\s+|the\s+)?(?:invalid|incorrect|wrong|unregistered|random)\s+(?:user ?name|user ?id|login(?: id)?)$/i, 'no-such-user-123', 'a username that does not exist'],
  [/^(?:an?\s+|the\s+)?(?:empty|blank)(?:\s+(?:value|string|text))?$|^nothing$/i, '', 'nothing'],
  [/^(?:an?\s+)?(?:very\s+)?long\s+(?:text|string|value|input|name)$/i, 'a'.repeat(300), 'a very long text (300 characters)'],
  [/^(?:some\s+)?special\s+characters?$/i, `!@#$%^&*()<>"'`, 'special characters'],
  [/^(?:a\s+)?(?:valid\s+)?(?:phone|mobile)(?:\s+number)?$/i, '9876543210', 'a phone number'],
  [/^(?:an?\s+)?(?:invalid)\s+(?:phone|mobile)(?:\s+number)?$/i, '12ab', 'an invalid phone number'],
  [/^(?:a\s+)?(?:valid\s+)?number$/i, '12345', 'a number'],
  [/^(?:a\s+)?negative\s+number$/i, '-1', 'a negative number'],
  [/^(?:a\s+)?(?:valid\s+)?(?:name|username|user name)$/i, 'Test User', 'a name'],
];

/** Field names testers write without a value: "Enter valid username", "Enter email id". */
const FIELD_NOUN = /^(?:e-?mail(?: id| address)?|user ?name|user ?id|login(?: id| name)?|password|confirm(?:ed)? password|pass ?code|pin|otp|(?:first |last |full |middle |company |display )?name|(?:phone|mobile|contact)(?: number| no\.?)?|address|city|state|country|zip(?: code)?|postal code|pin ?code|age|date of birth|dob|date|amount|quantity|qty|price|card number|cvv|expiry(?: date)?|comment|comments|message|description|search (?:term|text|keyword)|keyword|title|subject|website|url)$/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Strips articles and the control word from a phrase naming an element. */
export function cleanTarget(phrase: string): { target: string; hint?: string } {
  let t = clean(phrase).replace(/[.,;:]+$/, '');
  t = t.replace(new RegExp(`^(?:on\\s+)?(?:the\\s+|a\\s+|an\\s+|that\\s+)?`, 'i'), '');
  // A quoted name: "Sign in"
  const quoted = t.match(new RegExp(`^${QUOTE}\\s*(.*)$`));
  let hint: string | undefined;
  if (quoted) {
    const rest = clean(quoted[5] ?? '').toLowerCase();
    if (rest && HINTS[rest]) hint = HINTS[rest];
    return { target: q(quoted, 1) ?? '', hint };
  }
  // A leading control word: button Save, link Pricing
  const lead = t.match(new RegExp(`^(${HINT_ALTERNATION})\\s+(.+)$`, 'i'));
  const trail = t.match(new RegExp(`^(.+?)\\s+(${HINT_ALTERNATION})$`, 'i'));
  if (trail) {
    hint = HINTS[trail[2].toLowerCase()];
    t = trail[1];
  } else if (lead && lead[2].split(' ').length <= 3 && /^(button|link|tab|checkbox|radio|menu)$/i.test(lead[1])) {
    hint = HINTS[lead[1].toLowerCase()];
    t = lead[2];
  }
  const inner = t.match(new RegExp(`^${QUOTE}$`));
  if (inner) t = q(inner, 1) ?? t;
  return { target: clean(t), hint };
}

const STATE: Record<string, Check> = {
  displayed: 'visible', shown: 'visible', visible: 'visible', present: 'visible', appears: 'visible', appear: 'visible', appeared: 'visible', enabled: 'enabled', disabled: 'disabled', hidden: 'hidden',
  'not displayed': 'hidden', 'not visible': 'hidden', 'not shown': 'hidden', 'not present': 'hidden', absent: 'hidden', selected: 'checked', checked: 'checked', unchecked: 'unchecked', 'not checked': 'unchecked',
  'read-only': 'readonly', readonly: 'readonly', editable: 'editable', active: 'visible',
};
const STATE_WORDS = Object.keys(STATE).sort((a, b) => b.length - a.length).join('|');

function step(raw: string, p: Partial<ParsedStep>): ParsedStep {
  return { raw, action: 'unknown', confidence: 0, notes: [], ...p };
}

/** Value from a phrase: the quoted text if there is some, otherwise example data for a description, otherwise the words themselves. */
function valueOf(raw: string, phrase: string): { value: string; confidence: number; notes: string[] } {
  const m = phrase.trim().match(new RegExp(`^${QUOTE}$`));
  if (m) return { value: q(m, 1) ?? '', confidence: 0.97, notes: [] };
  for (const [re, data, label] of DATA) if (re.test(phrase.trim())) return { value: data, confidence: 0.72, notes: [`No exact text was given, so "${label}" is typed as ${JSON.stringify(data.length > 40 ? data.slice(0, 20) + '…' : data)}.`] };
  return { value: phrase.trim(), confidence: 0.6, notes: [`The text to use is not in quotes, so "${phrase.trim()}" is typed exactly as written.`] };
}

export function parseStep(input: string): ParsedStep {
  const p = readStep(input);
  // "<product name>": a gap the generator left for a person to fill in. Understood, but it cannot run as it is.
  if (p.action !== 'unknown' && [p.target, p.value].some((x) => /^<[a-z][a-z0-9 '-]{0,58}>$/i.test(x?.trim() ?? ''))) {
    return { ...p, confidence: Math.min(p.confidence, 0.4), notes: ['Replace the words in <angle brackets> with the real name or text from the page.', ...p.notes] };
  }
  return p;
}

function readStep(input: string): ParsedStep {
  const raw = input;
  let s = clean(input.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')).replace(/^(?:step\s*)?\d+\s*[.):-]\s*/i, '').replace(/\.$/, '');
  if (!s) return step(raw, { notes: ['The step is empty.'] });
  let m: RegExpMatchArray | null;

  // ---- open / navigation ---------------------------------------------------
  if ((m = s.match(/^(?:open|go to|goto|navigate to|visit|launch|browse to|load|access)\s+(.+)$/i))) {
    const rest = m[1].trim().replace(/^["']|["']$/g, '').trim(); // "/login" and /login mean the same
    if (/^https?:\/\//i.test(rest) || rest.startsWith('/') || /^[\w.%-]+(?:\/[\w.%~-]*)+(?:[?#]\S*)?$/.test(rest)) return step(raw, { action: 'open', value: rest, confidence: 0.98 });
    if (/^(?:the\s+)?(?:application|app|website|web site|site|web app|url|browser|home ?page|main page|start page)\b/i.test(rest)) {
      return step(raw, { action: 'open', value: '', confidence: 0.93, notes: ['Opens the app link you give when you run.'] });
    }
    const t = cleanTarget(rest);
    return step(raw, { action: 'open', target: t.target, hint: 'page', confidence: 0.68, notes: [`"${t.target}" is a page name, not an address. It goes to the app link, then follows a link called "${t.target}" if there is one.`] });
  }
  if (/^(?:refresh|reload)(?:\s+the)?(?:\s+(?:page|browser|screen))?$/i.test(s)) return step(raw, { action: 'refresh', confidence: 0.97 });
  if (/^(?:go|navigate|move)\s+back(?:\s+to the previous page)?$|^press\s+(?:the\s+)?(?:browser\s+)?back\s+button$/i.test(s)) return step(raw, { action: 'back', confidence: 0.95 });

  // ---- wait ----------------------------------------------------------------
  if ((m = s.match(/^wait(?:\s+for)?\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|milliseconds?|ms|minutes?)\b/i))) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith('m') && unit !== 'ms' && !unit.startsWith('milli') ? n * 60_000 : unit === 'ms' || unit.startsWith('milli') ? n : n * 1000;
    return step(raw, { action: 'wait', value: String(Math.min(ms, 60_000)), confidence: 0.96 });
  }
  if ((m = s.match(/^wait(?:\s+(?:until|for))\s+(.+?)(?:\s+to\s+(?:appear|be displayed|be visible|load|show|display))?$/i))) {
    const t = cleanTarget(m[1]);
    const q1 = m[1].match(new RegExp(`^${QUOTE}$`));
    return q1 ? step(raw, { action: 'verify', check: 'text', value: q(q1, 1), confidence: 0.85 }) : step(raw, { action: 'verify', check: 'visible', target: t.target, hint: t.hint, confidence: 0.8 });
  }

  // ---- press a key -----------------------------------------------------------
  if ((m = s.match(/^(?:press|hit|type)\s+(?:the\s+)?(enter|return|tab|escape|esc|space|spacebar|backspace|delete|home|end|page ?up|page ?down|arrow ?(?:up|down|left|right)|f\d{1,2})(?:\s+key)?$/i))) {
    const key = m[1].toLowerCase().replace(/\s+/g, '');
    const map: Record<string, string> = { return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', space: 'Space', spacebar: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight' };
    return step(raw, { action: 'press', value: map[key] ?? key.toUpperCase(), confidence: 0.96 });
  }

  // ---- verify ----------------------------------------------------------------
  const verb = s.match(/^(?:verify|validate|assert|confirm|ensure|expect|observe|see|make sure|check)\s+(?:that\s+|if\s+|whether\s+)?(.+)$/i);
  const isCheckAction = /^check\s+(?:the\s+)?(?!that\b|if\b|whether\b)/i.test(s) && !/\b(?:is|are|should)\b/i.test(s); // "Check the Remember me box" is an action
  const statement = /^(?:the\s+)?(?:page|screen|app|site|application|dashboard|message|banner|section)\s+(?:shows|displays|contains|says|reads|has the text|includes)\s+["']/i.test(s) || /\b(?:is|are|should be|gets?|was|were)\s+(?:now\s+)?(?:being\s+)?(?:redirected|navigated|taken|displayed|shown|visible|present|enabled|disabled|hidden|selected|checked|unchecked|absent|not\b)|\b(?:appears?|appeared|displayed|redirected)\s*$/i.test(s) || /["'].+["'].*\b(?:should not|shouldn't|does not|doesn't|do not|is no longer|are no longer|disappears?)\b/i.test(s) && !/^(?:click|press|tap|enter|type|select|choose)\b/i.test(s);
  if ((verb && !isCheckAction) || (!verb && statement)) {
    const r = clean(verb ? verb[1] : s);
    return parseVerify(raw, r);
  }

  // ---- type / clear -----------------------------------------------------------
  if ((m = s.match(new RegExp(`^(?:leave|keep|make)\\s+(?:the\\s+)?(.+?)\\s+(?:(?:${HINT_ALTERNATION})\\s+)?(?:empty|blank)$`, 'i')))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'clear', target: t.target, hint: t.hint ?? 'field', confidence: 0.92 });
  }
  if ((m = s.match(/^(?:clear|empty|erase|delete the text (?:in|from))\s+(?:the\s+)?(.+)$/i)) && !/checkbox|check box/i.test(m[1])) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'clear', target: t.target, hint: t.hint ?? 'field', confidence: 0.9 });
  }
  const typeVerb = '(?:enter|type|input|fill(?:\\s+in)?|key\\s+in|write|put|provide|set|submit)';
  /** Only words that mean typing, for the looser patterns below: "Submit the form" and "Set ..." stay clicks. */
  const fillVerb = '(?:enter|type|input|fill(?:\\s+in)?|key\\s+in|provide)';
  if ((m = s.match(new RegExp(`^${typeVerb}\\s+(${QUOTE})\\s+(?:in|into|in\\s+to|on|inside|as)\\s+(?:the\\s+)?(.+)$`, 'i')))) {
    const t = cleanTarget(m[6]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: valueOf(raw, m[1]).value, confidence: t.target ? 0.97 : 0.4 });
  }
  if ((m = s.match(new RegExp(`^${typeVerb}\\s+(?:the\\s+)?(.+?)\\s+(?:as|with|to|=|:)\\s+(${QUOTE})$`, 'i')))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: valueOf(raw, m[2]).value, confidence: t.target ? 0.95 : 0.4 });
  }
  // "Enter Username: admin", "Password = secret123"
  if ((m = s.match(new RegExp(`^${fillVerb}\\s+(?:the\\s+)?([^:=]{1,40}?)\\s*[:=]\\s*(.+)$`, 'i'))) && !/^https?$/i.test(m[1].trim())) {
    const t = cleanTarget(m[1]);
    const v = valueOf(raw, m[2]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: v.value, confidence: t.target ? Math.max(v.confidence, 0.88) : 0.4, notes: v.notes.filter((n) => !n.includes('not in quotes')) });
  }
  // "Enter username "admin"": the field first, then the text in quotes
  if ((m = s.match(new RegExp(`^${fillVerb}\\s+(?:the\\s+)?(.+?)\\s+(${QUOTE})$`, 'i'))) && !/\s(?:in|into|on|inside)\s/i.test(m[1])) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: valueOf(raw, m[2]).value, confidence: t.target ? 0.92 : 0.4 });
  }
  if ((m = s.match(new RegExp(`^${typeVerb}\\s+(.+?)\\s+(?:in|into|in\\s+to|on|inside)\\s+(?:the\\s+)?(.+)$`, 'i')))) {
    const v = valueOf(raw, m[1]);
    const t = cleanTarget(m[2]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: v.value, confidence: Math.min(v.confidence, t.target ? 0.9 : 0.4), notes: v.notes });
  }
  if ((m = s.match(new RegExp(`^${typeVerb}\\s+(?:the\\s+)?(.+?)\\s+(?:${HINT_ALTERNATION})?\\s*(?:and|then)?$`, 'i'))) && /\b(?:field|box|input|textbox)\b/i.test(m[1])) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'type', target: t.target, hint: 'field', value: '', needsValue: true, confidence: 0.45, notes: ['No text to enter was given.'] });
  }
  // "Fill the Full Name field with John", "Enter the city as Pune"
  if ((m = s.match(new RegExp(`^${fillVerb}\\s+(?:the\\s+)?(.+?)\\s+(?:with|as)\\s+(.+)$`, 'i')))) {
    const t = cleanTarget(m[1]);
    if (/^(?:form|details|data|information|info|all(?: the)? fields|(?:all )?(?:the )?(?:mandatory|required) fields|fields)$/i.test(t.target)) {
      return step(raw, { action: 'unknown', confidence: 0.3, notes: ['This fills several fields at once. Write one step per field, for example: Enter "Jane" in the First name field.'] });
    }
    const v = valueOf(raw, m[2]);
    return step(raw, { action: 'type', target: t.target, hint: t.hint ?? 'field', value: v.value, confidence: t.target ? Math.max(v.confidence, 0.78) : 0.4, notes: v.notes });
  }
  // "Enter valid username", "Enter email id", "Enter an invalid email": a field is named, the text is not
  if ((m = s.match(new RegExp(`^${fillVerb}\\s+(?:(?:a|an|the|your|some|any)\\s+)?(?:(valid|invalid|correct|incorrect|wrong|registered|unregistered|existing|new|different|random)\\s+)?(.+?)(?:\\s+(?:field|box|input|textbox|text box))?$`, 'i')))) {
    const quality = (m[1] ?? '').toLowerCase();
    const noun = m[2].replace(/\s+(?:id|address)$/i, (x) => (/email|e-mail/i.test(m![2]) ? '' : x)).trim();
    const known = FIELD_NOUN.test(noun);
    if (/^(?:credentials?|login details|details|data|information|info|values?|text|input|form|everything|all(?: fields)?|(?:all )?(?:the )?(?:mandatory|required) fields|fields)$/i.test(noun)) {
      return step(raw, { action: 'unknown', confidence: 0.3, notes: ['This names several fields at once. Write one step per field, for example: Enter "jane@example.com" in the Email field.'] });
    }
    if (known || noun.split(' ').length <= 3) {
      const label = noun.replace(/\b\w/g, (c) => c.toUpperCase());
      const credential = /user ?name|user ?id|login(?: id)?|password|passcode|pin|otp/i.test(noun);
      const sample = credential && !/invalid|incorrect|wrong|unregistered|random/.test(quality) ? undefined : DATA.find(([re]) => re.test(`${quality} ${noun}`.trim()) || (!quality && re.test(noun)));
      if (sample) {
        return step(raw, { action: 'type', target: label, hint: 'field', value: sample[1], confidence: known ? 0.72 : 0.6, notes: [`No exact text was given, so "${sample[2]}" is typed as ${JSON.stringify(sample[1].length > 40 ? sample[1].slice(0, 20) + '…' : sample[1])}.`] });
      }
      return step(raw, {
        action: 'type', target: label, hint: 'field', value: '', needsValue: true, confidence: known ? 0.55 : 0.45,
        notes: [`Which ${noun.toLowerCase()}? Add the text in quotes, for example: Enter "…" in the ${label} field.`],
      });
    }
  }
  // "Search for "laptop"": type it into the search box
  if ((m = s.match(new RegExp(`^search\\s+(?:for\\s+)?(${QUOTE}|.+)$`, 'i')))) {
    const v = valueOf(raw, m[1]);
    return step(raw, { action: 'type', target: 'Search', hint: 'field', value: v.value, confidence: Math.min(v.confidence, 0.8), notes: [...v.notes, 'Types it into the search box. If the search does not start by itself, add a step: Press Enter.'] });
  }

  // ---- select from a dropdown -----------------------------------------------------
  if ((m = s.match(new RegExp(`^(?:select|choose|pick)\\s+(.+?)\\s+(?:from|in)\\s+(?:the\\s+)?(.+)$`, 'i')))) {
    const v = valueOf(raw, m[1]);
    const t = cleanTarget(m[2]);
    return step(raw, { action: 'select', target: t.target, hint: t.hint ?? 'dropdown', value: v.value, confidence: Math.min(v.confidence + 0.02, 0.96) });
  }

  // ---- check / uncheck -------------------------------------------------------------
  if ((m = s.match(/^(?:uncheck|untick|deselect|turn off|switch off|disable)\s+(?:the\s+)?(.+)$/i))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'uncheck', target: t.target, hint: t.hint ?? 'checkbox', confidence: 0.9 });
  }
  if ((m = s.match(/^(?:check|tick|turn on|switch on|enable|mark|toggle on)\s+(?:the\s+)?(.+)$/i))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'check', target: t.target, hint: t.hint ?? 'checkbox', confidence: t.hint === 'checkbox' || t.hint === 'switch' || t.hint === 'radio' ? 0.94 : 0.8 });
  }

  // ---- hover / scroll -----------------------------------------------------------------
  if ((m = s.match(/^(?:hover|mouse over|move (?:the )?mouse (?:over|to))\s+(?:over\s+)?(?:the\s+)?(.+)$/i))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'hover', target: t.target, hint: t.hint, confidence: 0.9 });
  }
  if ((m = s.match(/^scroll\s+(?:down|up|to)(?:\s+(?:to\s+)?(?:the\s+)?(.+))?$/i))) {
    const t = m[1] ? cleanTarget(m[1]) : undefined;
    return step(raw, { action: 'scroll', target: t?.target, hint: t?.hint, confidence: 0.85 });
  }

  // ---- click (last, because "select" and "press" are also click words) ------------------------
  if ((m = s.match(/^(?:double[- ]click|click|press|tap|hit|push|choose|pick|select|activate|submit|open|expand|collapse|toggle)\s+(?:on\s+)?(?:the\s+)?(.+)$/i))) {
    const t = cleanTarget(m[1]);
    const bare = /^(?:submit)$/i.test(s.split(' ')[0]) && !t.hint;
    return step(raw, { action: 'click', target: t.target, hint: t.hint, confidence: !t.target ? 0.3 : t.hint ? 0.95 : bare ? 0.7 : 0.88 });
  }
  if ((m = s.match(/^(log ?out|log ?off|sign ?out)(?:\s+(?:from|of)\s+(?:the\s+|your\s+)?(?:application|app|site|website|web site|account|system|portal|page))?$/i))) {
    return step(raw, { action: 'click', target: m[1], confidence: 0.8, notes: [`Clicks the "${m[1]}" button or link. If it is inside a menu, add a step to open the menu first.`] });
  }
  if (/^(?:log ?in|sign ?in|submit|save|continue|next|search|register|sign ?up|log ?out|sign ?out)$/i.test(s)) {
    return step(raw, { action: 'click', target: s, hint: 'button', confidence: 0.7, notes: [`Read as "Click the ${s} button".`] });
  }

  return step(raw, {
    action: 'unknown', confidence: 0,
    notes: ['I could not tell what to do here. Try one of: Open "https://…" · Click the Save button · Enter "text" in the Email field · Select "UK" from the Country dropdown · Verify "Saved" is displayed.'],
  });
}

function parseVerify(raw: string, r: string): ParsedStep {
  let m: RegExpMatchArray | null;
  // "X does not appear", "X should not be shown", "X is no longer visible", "X disappears" all mean X is absent.
  if ((m = r.match(/^(.+?)\s+(?:does not|doesn't|do not|don't|did not|should not|shouldn't|must not|will not|won't|never)\s+(?:appear|display|show(?: up)?|exist|be (?:shown|displayed|visible|present|there)|remain|stay)\b.*$/i))
    || (m = r.match(/^(.+?)\s+(?:is|are) no longer\s+(?:displayed|shown|visible|present|there|available)$/i))
    || (m = r.match(/^(.+?)\s+(?:disappears?|vanish(?:es)?|goes away)$/i))) {
    return parseVerify(raw, `${m[1]} is not displayed`);
  }
  // Title and URL
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(?:page\\s+|browser\\s+|window\\s+)?title\\s+(is|equals|should be|contains|has|includes|should contain)\\s+(.+)$`, 'i')))) {
    const v = valueOf(raw, m[2]);
    return step(raw, { action: 'verify', check: 'title', value: v.value, exact: /^(is|equals|should be)$/i.test(m[1]), confidence: Math.min(v.confidence, 0.95), notes: v.notes });
  }
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(?:current\\s+|page\\s+)?(?:url|address|link|path)\\s+(is|equals|should be|contains|has|includes|should contain|ends with)\\s+(.+)$`, 'i')))) {
    const v = valueOf(raw, m[2]);
    return step(raw, { action: 'verify', check: 'url', value: v.value, exact: /^(is|equals|should be)$/i.test(m[1]), confidence: Math.min(v.confidence, 0.95), notes: v.notes });
  }
  if ((m = r.match(/^(?:the\s+)?(?:user|tester|customer|visitor|member)?\s*(?:is|gets|should be|will be|has been|was)?\s*(?:redirected|navigated|taken|brought|sent|directed)\s+to\s+(?:the\s+|a\s+|an\s+)?(.+?)(?:\s+(?:page|screen|view|section))?$/i))) {
    const t = m[1].trim().replace(/^["']|["']$/g, '');
    if (/^https?:\/\/|^\//.test(t)) return step(raw, { action: 'verify', check: 'url', value: t, confidence: 0.92 });
    return step(raw, { action: 'verify', check: 'page', value: t, confidence: 0.78, notes: [`Looks for "${t}" in the address, page title or main heading.`] });
  }
  // No error message
  if ((m = r.match(/^(?:no|there is no|there are no|without any)\s+(error|validation|warning)?\s*(?:message|messages|error|errors)?\s*(?:is|are)?\s*(?:displayed|shown|visible|present|appears?)?$/i)) && /\b(?:no|without)\b/i.test(r)) {
    return step(raw, { action: 'verify', check: 'no-message', kind: m[1]?.toLowerCase() ?? 'error', confidence: 0.85 });
  }
  // The error message "exact text" is displayed
  if ((m = r.match(new RegExp(`^(?:an?\\s+|the\\s+)?(error|success|warning|validation|confirmation|info|alert)\\s+(?:message|banner|toast|notification|alert|text)\\s+(${QUOTE})\\s*(?:is|are|should be)?\\s*(?:displayed|shown|visible|present|appears?|appeared)?$`, 'i')))) {
    return step(raw, { action: 'verify', check: 'text', value: q(m, 3), kind: m[1].toLowerCase(), confidence: 0.96 });
  }
  // A kind of message, with or without its exact text
  if ((m = r.match(new RegExp(`^(?:an?\\s+|the\\s+)?(error|success|warning|validation|confirmation|info|alert)\\s+(?:message|banner|toast|notification|alert|text)?\\s*(?:(?:saying|stating|reading|that says|with the text|with text|containing|:)\\s*(${QUOTE}|.+?))?\\s*(?:is|are|should be)?\\s*(?:displayed|shown|visible|present|appears?|appeared)?$`, 'i'))) && /(?:displayed|shown|visible|present|appears?|appeared|saying|stating|reading|that says|containing|:)/i.test(r)) {
    const kind = m[1].toLowerCase();
    const textPart = m[2];
    if (textPart) {
      const v = valueOf(raw, textPart.trim());
      return step(raw, { action: 'verify', check: 'text', value: v.value, kind, confidence: Math.min(v.confidence + 0.03, 0.97), notes: v.notes });
    }
    return step(raw, { action: 'verify', check: 'message', kind, confidence: 0.62, notes: [`No exact text was given, so this only checks that some ${kind} message appears.`] });
  }
  // "Text" is displayed
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(?:text|message|label|heading|title|word|phrase)?\\s*(${QUOTE})\\s+(?:is|are|should be|gets|was)?\\s*(?:now\\s+)?(?:displayed|shown|visible|present|appears?|appeared|on the page|on screen)$`, 'i')))) {
    return step(raw, { action: 'verify', check: 'text', value: q(m, 2), confidence: 0.96 });
  }
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(?:page|screen|app|site|application|message|banner|section|dashboard)?\\s*(?:shows|displays|contains|says|reads|has the text|has text|includes|lists)\\s+(${QUOTE})$`, 'i')))) {
    return step(raw, { action: 'verify', check: 'text', value: q(m, 2), confidence: 0.93 });
  }
  // A field's value
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(.+?)\\s+(?:${HINT_ALTERNATION})?\\s*(?:contains|has(?:\\s+the)?\\s+value|equals|is set to|shows|has the text|has text|reads|holds)\\s+(${QUOTE})$`, 'i'))) && !/^(?:page|screen|app|site|application|dashboard|message|banner)$/i.test(m[1].trim())) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'verify', check: 'value', target: t.target, hint: t.hint ?? 'field', value: q(m, 3), confidence: 0.9 });
  }
  // An element's state
  if ((m = r.match(new RegExp(`^(?:the\\s+)?(.+?)\\s+(?:is|are|should be|remains?|stays?|becomes?|gets?)\\s+(?:now\\s+)?(${STATE_WORDS})$`, 'i')))) {
    const t = cleanTarget(m[1]);
    const check = STATE[m[2].toLowerCase()];
    // The subject was a quoted piece of text ("Saved", the message "Saved"), not the name of an element.
    const qm = m[1].trim().match(new RegExp(`^(?:(?:the|a|an)\\s+)?(?:(?:error|success|warning|info)\\s+)?(?:(?:text|message|label|heading|word|phrase|title|banner|notification)\\s+)?${QUOTE}$`, 'i'));
    const quoted = qm ? q(qm, 1) : undefined;
    if (quoted !== undefined) {
      if (check === 'hidden') return step(raw, { action: 'verify', check: 'no-text', value: quoted, confidence: 0.9 });
      if (check === 'visible') return step(raw, { action: 'verify', check: 'text', value: quoted, confidence: 0.9 });
    }
    return step(raw, { action: 'verify', check, target: t.target, hint: t.hint, confidence: t.target ? (t.hint ? 0.9 : 0.8) : 0.3 });
  }
  if ((m = r.match(new RegExp(`^(.+?)\\s+(?:appears?|is displayed|is shown|is visible|displays?)$`, 'i')))) {
    const t = cleanTarget(m[1]);
    return step(raw, { action: 'verify', check: 'visible', target: t.target, hint: t.hint, confidence: t.target ? 0.72 : 0.3, notes: ['Checks that an element with this name is on the page.'] });
  }
  // Anything else after "verify": treat the rest as text that should appear
  const text = r.match(new RegExp(`^${QUOTE}$`));
  if (text) return step(raw, { action: 'verify', check: 'text', value: q(text, 1), confidence: 0.9 });
  return step(raw, { action: 'verify', check: 'text', value: r.replace(/^["']|["']$/g, ''), confidence: 0.5, notes: [`Checks that the words "${r}" appear on the page. If you meant something else, rewrite it, for example: Verify "Welcome" is displayed.`] });
}

/** A one-line description of how a step was read, for people. */
export function describeStep(p: ParsedStep): string {
  const t = p.target ? `“${p.target}”${p.hint ? ` ${p.hint}` : ''}` : '';
  switch (p.action) {
    case 'open': return p.value ? `Open ${p.value}` : p.target ? `Go to the ${p.target} page` : 'Open the app';
    case 'click': return `Click ${t}`;
    case 'type': return `Type ${JSON.stringify(p.value ?? '')} into ${t}`;
    case 'clear': return `Clear ${t}`;
    case 'select': return `Choose ${JSON.stringify(p.value ?? '')} in ${t}`;
    case 'check': return `Tick ${t}`;
    case 'uncheck': return `Untick ${t}`;
    case 'hover': return `Hover over ${t}`;
    case 'press': return `Press ${p.value}`;
    case 'wait': return `Wait ${Number(p.value) / 1000}s`;
    case 'refresh': return 'Reload the page';
    case 'back': return 'Go back';
    case 'scroll': return p.target ? `Scroll to ${t}` : 'Scroll';
    case 'verify': {
      const c = p.check;
      if (c === 'text') return `Check the page shows ${JSON.stringify(p.value ?? '')}`;
      if (c === 'no-text') return `Check the page does not show ${JSON.stringify(p.value ?? '')}`;
      if (c === 'title') return `Check the page title ${p.exact ? 'is' : 'contains'} ${JSON.stringify(p.value ?? '')}`;
      if (c === 'url') return `Check the address ${p.exact ? 'is' : 'contains'} ${JSON.stringify(p.value ?? '')}`;
      if (c === 'page') return `Check we are on the ${p.value} page`;
      if (c === 'message') return `Check a${p.kind === 'error' ? 'n' : ''} ${p.kind} message appears`;
      if (c === 'no-message') return `Check no ${p.kind} message appears`;
      if (c === 'value') return `Check ${t} holds ${JSON.stringify(p.value ?? '')}`;
      return `Check ${t} is ${c}`;
    }
    default: return 'Not understood';
  }
}

