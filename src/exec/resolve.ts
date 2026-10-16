import type { UINode } from '../model.js';

/** Finds the element a phrase like "the Sign in button" means, by comparing the phrase with what each element says about itself. */

export interface Match {
  node: UINode;
  /** 0 to 1. */
  score: number;
  /** Which of the element's labels matched, for explaining the choice. */
  via: string;
}

export interface Ranked {
  best?: Match;
  /** More than one element scored almost the same, so the choice is a guess. */
  ambiguous: boolean;
  /** The next best candidates, for a person to choose from. */
  alternatives: Match[];
  /** 0 to 1: the best score, lowered when the choice was ambiguous. */
  confidence: number;
}

const STOP = new Set(['the', 'a', 'an', 'of', 'your', 'my', 'please', 'to', 'for']);

/** Lower-case words, splitting camelCase, kebab-case and snake_case, so "emailField" and "Email field" read alike. */
export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w));
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((w, i) => w === b[i]);

/** How alike two phrases are: 1 for the same words, high when one holds all the words of the other, low for a partial overlap. */
export function similarity(target: string, label: string): number {
  const t = words(target);
  const l = words(label);
  if (!t.length || !l.length) return 0;
  if (same(t, l)) return 1;
  const tSet = new Set(t);
  const lSet = new Set(l);
  const common = [...tSet].filter((w) => lSet.has(w)).length;
  if (common === tSet.size) return 0.8 + 0.15 * (tSet.size / lSet.size); // the label says everything the phrase does, and more
  if (common === lSet.size) return 0.5 + 0.25 * (lSet.size / tSet.size); // the phrase says more than the label
  return 0.65 * (common / (tSet.size + lSet.size - common));
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);

/** Which element roles and tags fit each word testers use for a control. */
const FITS: Record<string, { roles: string[]; tags: string[]; partial?: string[] }> = {
  button: { roles: ['button'], tags: ['button'], partial: ['link', 'menuitem', 'tab'] },
  link: { roles: ['link'], tags: ['a'], partial: ['button', 'menuitem', 'tab'] },
  field: { roles: ['textbox', 'searchbox', 'combobox', 'spinbutton'], tags: ['input', 'textarea'] },
  checkbox: { roles: ['checkbox', 'switch'], tags: [] },
  radio: { roles: ['radio'], tags: [] },
  dropdown: { roles: ['combobox', 'listbox'], tags: ['select'] },
  tab: { roles: ['tab'], tags: [], partial: ['button', 'link'] },
  menu: { roles: ['menu', 'menuitem'], tags: [], partial: ['button', 'link'] },
  menuitem: { roles: ['menuitem'], tags: [], partial: ['link', 'button'] },
  switch: { roles: ['switch', 'checkbox'], tags: [] },
  heading: { roles: ['heading'], tags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
  image: { roles: ['img'], tags: ['img'] },
  icon: { roles: ['button', 'link', 'img'], tags: [] },
  option: { roles: ['option', 'radio', 'checkbox'], tags: ['option'] },
  label: { roles: [], tags: ['label'] },
};

function fit(node: UINode, hint: string | undefined, mode: 'act' | 'see'): number {
  if (!hint || !FITS[hint]) {
    if (mode === 'see') return 1;
    // No hint: something clickable is far more likely than a block of text.
    if (node.role !== 'generic' || INTERACTIVE_TAGS.has(node.tag)) return 1;
    return 0.7;
  }
  const f = FITS[hint];
  const isTextInput = node.tag === 'input' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(node.attrs.type ?? 'text');
  if (hint === 'field' && node.tag === 'input' && !isTextInput) return 0.5;
  if (f.roles.includes(node.role) || f.tags.includes(node.tag)) return 1;
  if (f.partial?.includes(node.role)) return 0.85;
  return 0.55;
}

/** True when the element is the kind of control the word names (a "button", a "field"...). */
export function fitsHint(node: UINode, hint: string | undefined): boolean {
  return fit(node, hint, 'act') >= 0.85;
}

/** Everything an element says about itself, with how much each source is trusted. */
function labelsOf(n: UINode): [string, string, number][] {
  const out: [string, string, number][] = [];
  const add = (v: string | undefined, via: string, w: number) => {
    if (v && v.trim()) out.push([v, via, w]);
  };
  add(n.name, 'its name', 1);
  add(n.text, 'its text', 1);
  add(n.attrs.placeholder, 'its placeholder', 1);
  add(n.attrs.title, 'its tooltip', 0.95);
  add(n.attrs['data-testid'] ?? n.attrs['data-test'], 'its test id', 0.85);
  add(n.attrs.name, 'its name attribute', 0.85);
  add(n.attrs.id, 'its id', 0.85);
  return out;
}

/**
 * Ranks the elements of a page against a phrase. `mode` is 'act' when the step will click or type (prefer controls)
 * and 'see' when it only needs to find something on the page (any element, smallest first).
 */
export function rank(nodes: UINode[], target: string, hint: string | undefined, mode: 'act' | 'see' = 'act', near?: UINode): Ranked {
  const scored: Match[] = [];
  const plain = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = plain(target);
  for (const node of nodes) {
    let best = 0;
    let via = '';
    for (const [label, source, weight] of labelsOf(node)) {
      // The very same words, small ones included, beat a match that only holds once "your" or "the" are ignored:
      // "Email Address" is the login field, not the newsletter's "Your email address".
      const s = similarity(target, label) * weight + (plain(label) === wanted ? 0.02 : 0);
      if (s > best) {
        best = s;
        via = source;
      }
    }
    if (best <= 0.3) continue;
    const score = best * fit(node, hint, mode);
    if (score > 0.3) scored.push({ node, score, via });
  }
  // Higher score first. On a tie: the text rather than the page section around it; then the element in the same form or
  // section as the previous step's; then the one a person reads first (top to bottom, left to right).
  const closeness = (n: UINode) => {
    if (!near) return 0;
    const a = n.cssPath.split(' '), b = near.cssPath.split(' ');
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    return k;
  };
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.005) return b.score - a.score;
    if (contains(a.node, b.node)) return 1;
    if (contains(b.node, a.node)) return -1;
    return closeness(b.node) - closeness(a.node) || a.node.rect.y - b.node.rect.y || a.node.rect.x - b.node.rect.x;
  });
  const best = scored[0];
  if (!best) return { ambiguous: false, alternatives: [], confidence: 0 };
  const rivals = scored.filter((m) => m !== best && best.score - m.score < 0.05 && m.node.cssPath !== best.node.cssPath && !contains(best.node, m.node) && !contains(m.node, best.node));
  const ambiguous = rivals.length > 0;
  return {
    best,
    ambiguous,
    alternatives: scored.filter((m) => m !== best).slice(0, 3),
    confidence: Math.min(1, ambiguous ? best.score * 0.85 : best.score),
  };
}

/** True when `outer`'s box fully holds `inner`'s: a label around its checkbox is not a rival to the checkbox. */
function contains(outer: UINode, inner: UINode): boolean {
  const a = outer.rect;
  const b = inner.rect;
  return a.x <= b.x + 1 && a.y <= b.y + 1 && a.x + a.w >= b.x + b.w - 1 && a.y + a.h >= b.y + b.h - 1 && a.w * a.h > b.w * b.h;
}
