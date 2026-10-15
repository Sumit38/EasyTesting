import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { AutoHealer } from '../auto/auto-healer.js';
import { CoverageRecorder, type PageLike } from '../auto/coverage.js';
import { browserFn } from '../browser.js';
import type { HealRecord } from '../core.js';
import { playwrightProbe } from '../healer.js';
import type { Fingerprint, Snapshot, UINode } from '../model.js';
import { FingerprintStore } from '../store.js';
import type { TestCase } from '../cases/model.js';
import { parseStep, type ParsedStep } from '../cases/steps.js';
import { blockedReason } from './guard.js';
import { fitsHint, rank, type Ranked } from './resolve.js';

export interface RunOptions {
  cases: TestCase[];
  appUrl: string;
  healDir: string;
  storeFile: string;
  headless?: boolean;
  /** How long a step may look for its element or its expected result. */
  stepTimeout?: number;
  /** Refuse any address that is not on the public internet (this machine, private networks, files). On for shared servers. */
  blockPrivate?: boolean;
  log?: (line: string) => void;
}

export interface StepResult {
  index: number;
  text: string;
  action: ParsedStep['action'];
  target?: string;
  value?: string;
  status: 'passed' | 'failed' | 'skipped';
  /** The failure was the page not loading (site or network), not something the app did wrong. */
  environment?: boolean;
  /** The step itself could not be run as written (not understood, or no text to type): a problem with the test case, not the app. */
  unreadable?: boolean;
  /** How sure the reader was that it understood the step. */
  parseConfidence: number;
  /** How sure the tool was that it found the right element (1 when the step names none). */
  resolveConfidence: number;
  confidence: number;
  /** How the element was found: saved from a green run, healed by fingerprint, or found by name. */
  via?: 'saved' | 'healed' | 'name';
  selector?: string;
  matchedAs?: string;
  error?: string;
  alternatives?: string[];
  notes: string[];
  ms: number;
  screenshot?: string;
}

export interface CaseResult {
  id: string;
  title: string;
  /** 'blocked': a page would not load, so the case could not be judged either way. */
  status: 'passed' | 'failed' | 'skipped' | 'blocked';
  steps: StepResult[];
  /** 0-100: mean confidence of the steps that ran. */
  confidence: number;
  /** 0-100: how well the steps were understood, before running. */
  understanding: number;
  /** The case's expected result was a guess made when it was generated. */
  assumed?: boolean;
  durationMs: number;
  advice?: string;
}

class StepError extends Error {
  constructor(message: string, readonly alternatives?: string[], readonly kind: 'missing' | 'check' | 'action' | 'environment' = 'action') {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const hashId = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);
const describeNode = (n: UINode) => `${n.role !== 'generic' ? n.role + ' ' : ''}"${n.name || n.text || n.tag}"`;

/** Opens a page, trying twice: busy public sites are sometimes slow once. A page that still will not load is reported as a site or network problem, not a failure of the app. */
async function gotoWithRetry(page: Page, url: string): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    } catch (e) {
      last = e;
      await sleep(1000);
    }
  }
  throw new StepError(`The page ${url} did not load: ${(last as Error).message.split('\n')[0]}`, undefined, 'environment');
}

/** Opens a page, after checking the address is one this server allows. */
async function openPage(page: Page, url: string, ctx: Ctx): Promise<void> {
  const why = ctx.blockPrivate ? await blockedReason(url) : /^https?:/i.test(url) ? undefined : `Only http:// and https:// addresses can be tested, not ${url.split(':')[0]}:`;
  if (why) throw new StepError(why, undefined, 'environment');
  await gotoWithRetry(page, url);
}

/** The first browser Playwright can start here: Chrome, Edge, then its own Chromium. */
export async function launchBrowser(headless = true): Promise<Browser> {
  let last: unknown;
  for (const channel of [undefined, 'chrome', 'msedge'] as const) {
    try {
      return await chromium.launch({ channel, headless, args: ['--disable-dev-shm-usage'] });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`No browser could be started. Install Google Chrome or Microsoft Edge. (${(last as Error)?.message?.split('\n')[0] ?? ''})`);
}

async function snapshot(page: Page): Promise<Snapshot> {
  for (let i = 0; ; i++) {
    try {
      return (await page.evaluate(browserFn as never)) as Snapshot;
    } catch (e) {
      // The page is navigating; wait for it and look again.
      if (i >= 4) throw e;
      await sleep(250);
    }
  }
}

/** First selector for the node that matches exactly it and nothing else. */
async function stableSelector(page: Page, probe: ReturnType<typeof playwrightProbe>, node: UINode): Promise<string | undefined> {
  for (const sel of probe.candidates(node)) {
    if ((await page.locator(sel).count().catch(() => 0)) !== 1) continue;
    const found = await probe.describe(sel).catch(() => null);
    if (found && found.cssPath === node.cssPath) return sel;
  }
  return undefined;
}

export async function runCases(opts: RunOptions): Promise<{ results: CaseResult[]; passed: boolean }> {
  const log = opts.log ?? (() => undefined);
  const shown = (t: string) => (t.length > 110 ? t.slice(0, 107) + '...' : t);
  const timeout = opts.stepTimeout ?? 8000;
  mkdirSync(join(opts.healDir, 'shots'), { recursive: true });
  const healer = new AutoHealer({ dir: opts.healDir, storeFile: opts.storeFile, lookupTimeout: 300 });
  const index = new FingerprintStore(opts.storeFile); // step -> the selector that worked last time
  const coverage = new CoverageRecorder(opts.healDir);
  const results: CaseResult[] = [];
  const browser = await launchBrowser(opts.headless !== false && process.env.HEADED !== '1');
  const base = new URL(opts.appUrl);

  try {
    for (const c of opts.cases) {
      const started = Date.now();
      const label = `${c.id} ${c.title}`;
      log(`\n▶ ${label}`);
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      if (opts.blockPrivate) {
        // Every request, including redirects and the files a page loads, not only the addresses a step names.
        await context.route('**/*', async (route) => ((await blockedReason(route.request().url())) ? route.abort('blockedbyclient') : route.continue()));
      }
      const page = await context.newPage();
      page.on('dialog', (d) => void d.accept().catch(() => undefined));
      healer.setTest(label);
      const steps: StepResult[] = [];
      let failed = false;

      for (let i = 0; i < c.steps.length; i++) {
        const text = c.steps[i];
        const parsed = parseStep(text);
        const t0 = Date.now();
        const r: StepResult = {
          index: i, text, action: parsed.action, target: parsed.target, value: parsed.value, status: 'skipped', parseConfidence: parsed.confidence,
          resolveConfidence: 1, confidence: parsed.confidence, notes: [...parsed.notes], ms: 0,
        };
        steps.push(r);
        if (failed) continue;
        if (parsed.action === 'unknown') {
          failed = true;
          r.status = 'failed';
          r.error = 'This step could not be understood, so the case was stopped here.';
          r.unreadable = true;
          r.ms = Date.now() - t0;
          log(`  ✖ ${i + 1}. ${shown(text)}  (not understood)`);
          continue;
        }
        if (parsed.needsValue) {
          failed = true;
          r.status = 'failed';
          r.error = `This step names the ${parsed.target ?? ''} field but not what to type in it, so the case was stopped here. Add the text in quotes, for example: Enter "…" in the ${parsed.target ?? ''} field.`;
          r.unreadable = true;
          r.ms = Date.now() - t0;
          log(`  ✖ ${i + 1}. ${shown(text)}  (no text to type)`);
          continue;
        }
        try {
          await doStep(page, parsed, { base, appUrl: opts.appUrl, blockPrivate: !!opts.blockPrivate, healer, index, coverage, key: `step::${c.id}::${i}::${norm(parsed.target ?? '')}`, timeout, r });
          r.status = 'passed';
          r.confidence = Math.min(parsed.confidence, r.resolveConfidence);
          log(`  ✔ ${i + 1}. ${shown(text)}${r.via && r.via !== 'saved' ? `  [${r.via}]` : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        } catch (e) {
          failed = true;
          r.status = 'failed';
          r.error = (e as Error).message.split('\n')[0];
          if (e instanceof StepError) {
            r.alternatives = e.alternatives;
            if (e.kind === 'environment') r.environment = true;
          }
          r.confidence = Math.min(parsed.confidence, r.resolveConfidence);
          try {
            const file = `${c.id}-step${i + 1}.png`.replace(/[^\w.-]/g, '_');
            await page.screenshot({ path: join(opts.healDir, 'shots', file) });
            r.screenshot = file;
          } catch {
            /* the page may be gone */
          }
          if (r.via === 'healed') healer.done(r.selector ?? '', false);
          log(`  ✖ ${i + 1}. ${text}\n      ${r.error}`);
        }
        r.ms = Date.now() - t0;
        await coverage.visit(pageLike(page)).catch(() => undefined);
      }

      await context.close().catch(() => undefined);
      const ran = steps.filter((s) => s.status !== 'skipped');
      const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : 0);
      const failedStep = steps.find((s) => s.status === 'failed');
      results.push({
        id: c.id, title: c.title, steps, durationMs: Date.now() - started,
        status: !c.steps.length ? 'skipped' : failedStep?.environment ? 'blocked' : failedStep ? 'failed' : 'passed',
        confidence: mean(ran.map((s) => s.confidence)), understanding: mean(steps.map((s) => s.parseConfidence)),
        assumed: c.basis === 'assumed' || undefined,
        advice: failedStep ? adviceFor(failedStep, c.basis === 'assumed') : undefined,
      });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  writeResults(opts.healDir, results);
  return { results, passed: results.every((r) => r.status === 'passed' || r.status === 'skipped') };
}

function adviceFor(s: StepResult, assumed = false): string {
  if (s.environment) return `Step ${s.index + 1} could not load the page (the site or the network was slow or unreachable). That says nothing about the app, so this case is blocked, not failed. Run it again.`;
  if (s.action === 'unknown') return `Step ${s.index + 1} could not be read. Rewrite it in the review screen.`;
  if (s.unreadable) return `Step ${s.index + 1} names a field but not what to type in it. Add the text in quotes in the review screen, then run again.`;
  if (s.parseConfidence < 0.6) return `Step ${s.index + 1} may have been misread (${Math.round(s.parseConfidence * 100)}% sure). Check how it was understood before calling this a bug.`;
  if (/could not find/i.test(s.error ?? '')) return `Step ${s.index + 1} could not find "${s.target}". Either the page changed or the step names it differently. Compare with the closest matches shown.`;
  if (s.action === 'verify' && assumed) return `Step ${s.index + 1} checked something the use case never stated: this case's expected result was a guess. Decide what the app should do. If it is right, edit the last step or delete the case; if not, it is a defect.`;
  if (s.action === 'verify') return `Step ${s.index + 1} was understood clearly and the check failed, so this looks like a real defect.`;
  return `Step ${s.index + 1} failed: ${s.error}`;
}

function pageLike(page: Page): PageLike {
  const probe = playwrightProbe(page, 300);
  return { url: () => page.url(), title: () => page.title(), snapshot: () => probe.snapshot() };
}

function writeResults(dir: string, results: CaseResult[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'results.json'),
    JSON.stringify({
      framework: 'cases',
      // A case stopped by a step it could not run as written was not really tested: it is reported as not run, never as a bug in the app.
      tests: results.map((r) => ({
        title: `${r.id} ${r.title}`, file: 'test-cases', assumed: r.assumed, status: r.status === 'passed' ? 'passed' : r.status === 'skipped' || r.steps.some((s) => s.unreadable) ? 'skipped' : r.status === 'blocked' ? 'interrupted' : 'failed', flaky: false, durationMs: r.durationMs, retries: 0,
        error: r.steps.find((s) => s.status === 'failed')?.error, errorLine: r.steps.find((s) => s.status === 'failed')?.error,
      })),
    }, null, 2),
  );
  writeFileSync(join(dir, 'steps.json'), JSON.stringify({ cases: results }, null, 2));
}

interface Ctx {
  base: URL;
  appUrl: string;
  blockPrivate: boolean;
  healer: AutoHealer;
  index: FingerprintStore;
  coverage: CoverageRecorder;
  key: string;
  timeout: number;
  r: StepResult;
  /** The locator a healed step now uses, so the step can be confirmed or failed once it has run. */
  healedSelector?: string;
}

const NEEDS_ELEMENT: ParsedStep['action'][] = ['click', 'type', 'clear', 'select', 'check', 'uncheck', 'hover'];
const IMPLICIT_HINT: Partial<Record<ParsedStep['action'], string>> = { type: 'field', clear: 'field', select: 'dropdown', check: 'checkbox', uncheck: 'checkbox' };

/** Finds the element for a step: the selector that worked last time, else fingerprint healing, else its name. */
async function locate(page: Page, p: ParsedStep, ctx: Ctx, mode: 'act' | 'see'): Promise<{ selector: string; node?: UINode }> {
  const { r, healer, index } = ctx;
  const probe = playwrightProbe(page, 300);
  const hint = p.hint && p.hint !== 'page' ? p.hint : IMPLICIT_HINT[p.action];
  const target = p.target ?? '';
  const saved = mode === 'act' ? index.get(ctx.key) : undefined;
  let healedFrom: string | undefined;

  if (saved) {
    const n = await page.locator(saved.selector).count().catch(() => 0);
    if (n === 1) {
      r.via = 'saved';
      r.selector = saved.selector;
      return { selector: saved.selector };
    }
    if (n === 0) {
      // The locator that worked last time no longer finds anything. Fingerprint matching first.
      const healed = await healer.heal(probe, saved.selector, undefined);
      if (healed !== saved.selector) {
        const rec = healer.recordFor(saved.selector);
        r.via = 'healed';
        r.selector = saved.selector; // the key `done` settles
        r.resolveConfidence = rec?.confidence ?? 0.7;
        r.matchedAs = rec?.matched ? describeNode(rec.matched) : undefined;
        r.notes.push(`The saved locator ${saved.selector} stopped matching; the element was found again by comparing it with how it looked before.`);
        ctx.healedSelector = healed;
        return { selector: healed, node: rec?.matched };
      }
      healedFrom = saved.selector;
    }
  }

  // By name, waiting for the page to settle.
  const deadline = Date.now() + ctx.timeout;
  let ranked: Ranked = { ambiguous: false, alternatives: [], confidence: 0 };
  let snap: Snapshot | undefined;
  do {
    snap = await snapshot(page);
    ranked = rank(snap.nodes, target, hint, mode);
    if (ranked.best && ranked.best.score >= 0.6) break;
    await sleep(250);
  } while (Date.now() < deadline);

  if (!ranked.best || ranked.best.score < 0.6) {
    const close = ranked.alternatives
      .concat(ranked.best ? [ranked.best] : [])
      .filter((m) => (hint ? fitsHint(m.node, hint) : true) && (m.node.name || m.node.text).length <= 60)
      .slice(0, 3)
      .map((m) => describeNode(m.node));
    // Nothing is named like the step says: list what this kind of control IS called on the page, so the step can be reworded.
    const onPage = hint
      ? [...new Set((snap?.nodes ?? []).filter((n) => fitsHint(n, hint) && (n.name || n.text) && (n.name || n.text).length <= 60).map((n) => `"${(n.name || n.text).slice(0, 40)}"`))].slice(0, 6)
      : [];
    const parts = [`Could not find "${target}"${hint ? ` (${hint})` : ''} on the page.`];
    if (close.length) parts.push(`Closest: ${close.join(', ')}.`);
    else if (onPage.length) parts.push(`${hint === 'field' ? 'Fields' : hint === 'dropdown' ? 'Dropdowns' : `${hint?.[0].toUpperCase()}${hint?.slice(1)}s`} on this page: ${onPage.join(', ')}.`);
    throw new StepError(parts.join(' '), close.length ? close : onPage, 'missing');
  }
  const node = ranked.best.node;
  r.resolveConfidence = ranked.confidence;
  r.matchedAs = describeNode(node);
  r.via = 'name';
  if (ranked.ambiguous) r.notes.push(`Several elements fit "${target}" equally well; the first was used. Others: ${ranked.alternatives.map((m) => describeNode(m.node)).join(', ')}.`);
  const selector = (await stableSelector(page, probe, node)) ?? node.cssPath;
  r.selector = selector;

  if (healedFrom) {
    // The saved locator broke and fingerprint matching was unsure, but the element was found by name: record it as a heal.
    healer.dropRefused(healedFrom);
    const score = ranked.best.score;
    const verdict = score >= 0.85 && !ranked.ambiguous ? 'auto' : 'suggest';
    const old = saved!.node;
    const rec: HealRecord = {
      id: hashId(`${ctx.key}\0${healedFrom}`), test: ctx.healer.testName, key: `${ctx.healer.testName}::${healedFrom}`, oldSelector: healedFrom, newSelector: selector, verdict, confidence: score,
      reason: `The saved locator stopped matching. Found again by its name "${target}".`, oldNode: old, matched: node, status: 'retried',
      decision: { verdict, confidence: score, reason: 'Found by name', best: { node, score, signals: { attr: 0, text: score, tree: 0, pos: 0, role: 1 } }, top: [] },
      fingerprintAfter: { node, viewport: snap.viewport, selector },
    };
    healer.note(rec);
    r.via = 'healed';
    r.selector = healedFrom;
    ctx.healedSelector = selector;
    r.notes.push(`The saved locator ${healedFrom} stopped matching; "${target}" was found again by its name.`);
  }
  return { selector, node };
}

async function remember(page: Page, ctx: Ctx, selector: string) {
  const probe = playwrightProbe(page, 300);
  try {
    const node = await probe.describe(selector);
    if (!node) return;
    const fp: Fingerprint = { node, viewport: await probe.viewport(), selector };
    ctx.index.set(ctx.key, fp);
    await ctx.healer.remember(probe, selector);
    await ctx.coverage.interact(pageLike(page), probe, selector);
  } catch {
    /* learning is best effort */
  }
}

async function poll<T>(timeout: number, fn: () => Promise<T | undefined | false>): Promise<T | undefined> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch {
      /* the page may be mid-navigation: look again */
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(250);
  }
}

const pageText = (page: Page) => page.evaluate(`document.body ? document.body.innerText : ''`) as Promise<string>;

/** Visible message-like elements: alerts, toasts and anything classed as an error, success or warning. */
const MESSAGES_JS = `(() => {
  const sel = '[role=alert],[role=status],[aria-live],[class*=error i],[class*=invalid i],[class*=alert i],[class*=toast i],[class*=success i],[class*=warning i],[class*=notification i],[class*=message i],[id*=error i],[id*=toast i],[id*=success i],[id*=message i]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    if (t) out.push({ text: t.slice(0, 200), cls: String(el.className || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('role') || '') });
  }
  return out;
})()`;

/** Fields the page has marked as wrong without printing a message: aria-invalid, an error class, or the browser's own invalid state after use. */
const FLAGGED_JS = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cls = String(el.className || '');
    let userInvalid = false;
    try { userInvalid = el.matches(':user-invalid'); } catch (e) { userInvalid = false; }
    if (el.getAttribute('aria-invalid') === 'true' || userInvalid || /(^|[\\s_-])(error|invalid|danger|has-error|is-invalid|field-error)($|[\\s_-])/i.test(cls)) {
      out.push(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || el.tagName.toLowerCase());
    }
  }
  return out;
})()`;

const KINDS: Record<string, RegExp> = {
  error: /error|invalid|required|incorrect|wrong|fail|not valid|denied|must|cannot|can't|unable|too (short|long)|alert|danger/i,
  validation: /error|invalid|required|incorrect|wrong|must|not valid/i,
  success: /success|saved|thank|welcome|done|created|sent|updated|complete/i,
  confirmation: /success|saved|thank|confirm|done|created|sent|updated|complete/i,
  warning: /warn|caution|careful/i,
};

async function doStep(page: Page, p: ParsedStep, ctx: Ctx): Promise<void> {
  const { r, base } = ctx;
  const t = ctx.timeout;
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => undefined);
    await sleep(120);
  };

  switch (p.action) {
    case 'open': {
      if (p.value) {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(p.value) ? p.value : new URL(p.value, base).href;
        await openPage(page, url, ctx);
      } else {
        if (page.url() === 'about:blank') await openPage(page, ctx.appUrl, ctx);
        if (p.target) {
          // "Go to the Billing page": follow a link of that name if the page has one, otherwise we are already there.
          const snap = await snapshot(page);
          const m = rank(snap.nodes, p.target, 'link', 'act');
          if (m.best && m.best.score >= 0.85) {
            const sel = (await stableSelector(page, playwrightProbe(page, 300), m.best.node)) ?? m.best.node.cssPath;
            await page.locator(sel).first().click({ timeout: t });
            await settle();
            r.matchedAs = describeNode(m.best.node);
          } else r.notes.push(`No link called "${p.target}" was found, so the page the app link opened was used.`);
        }
      }
      await settle();
      return;
    }
    case 'refresh':
      await page.reload({ waitUntil: 'domcontentloaded' });
      return;
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded' });
      return;
    case 'wait':
      await sleep(Number(p.value) || 1000);
      return;
    case 'press':
      await page.keyboard.press(p.value ?? 'Enter');
      await settle();
      return;
    case 'scroll': {
      if (p.target) {
        const { selector } = await locate(page, p, ctx, 'see');
        await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: t });
      } else await page.mouse.wheel(0, 600);
      return;
    }
  }

  if (NEEDS_ELEMENT.includes(p.action)) {
    const { selector } = await locate(page, p, ctx, 'act');
    const el = page.locator(selector).first();
    // Describe the element before acting: a click that navigates leaves it behind.
    await remember(page, ctx, ctx.healedSelector ?? r.selector!);
    try {
      if (p.action === 'click') {
        await el.click({ timeout: t });
        await settle();
      } else if (p.action === 'hover') await el.hover({ timeout: t });
      else if (p.action === 'type') {
        await el.fill(p.value ?? '', { timeout: t }).catch(async () => {
          await el.click({ timeout: t });
          await page.keyboard.press('Control+A');
          await page.keyboard.type(p.value ?? '');
        });
      } else if (p.action === 'clear') await el.fill('', { timeout: t });
      else if (p.action === 'check') await el.check({ timeout: t });
      else if (p.action === 'uncheck') await el.uncheck({ timeout: t });
      else if (p.action === 'select') {
        const value = p.value ?? '';
        await el.selectOption({ label: value }, { timeout: t }).catch(() => el.selectOption(value, { timeout: t })).catch(() => {
          throw new StepError(`The option "${value}" is not in the "${p.target}" list.`, undefined, 'action');
        });
      }
    } catch (e) {
      if (e instanceof StepError) throw e;
      throw new StepError(`Could not ${p.action} "${p.target}": ${(e as Error).message.split('\n')[0]}`, undefined, 'action');
    }
    // The step worked: confirm any heal.
    if (r.via === 'healed') ctx.healer.done(r.selector!, true);
    return;
  }

  if (p.action === 'verify') return verify(page, p, ctx);
}

async function verify(page: Page, p: ParsedStep, ctx: Ctx): Promise<void> {
  const t = ctx.timeout;
  const fail = (m: string) => new StepError(m, undefined, 'check');
  const want = p.value ?? '';
  switch (p.check) {
    case 'text': {
      const ok = await poll(t, async () => norm(await pageText(page)).includes(norm(want)));
      if (!ok) throw fail(`The text ${JSON.stringify(want)} is not on the page.`);
      return;
    }
    case 'no-text': {
      // Give the page a moment to react before declaring something absent, then wait for it to go if it is there.
      await sleep(500);
      const gone = await poll(Math.min(t, 4000), async () => !norm(await pageText(page)).includes(norm(want)));
      if (!gone) throw fail(`The text ${JSON.stringify(want)} is on the page, but it should not be.`);
      return;
    }
    case 'title': {
      const ok = await poll(t, async () => {
        const title = await page.title();
        return p.exact ? title === want : norm(title).includes(norm(want));
      });
      if (!ok) throw fail(`The page title is ${JSON.stringify(await page.title())}, not ${p.exact ? '' : 'containing '}${JSON.stringify(want)}.`);
      return;
    }
    case 'url': {
      const ok = await poll(t, async () => (p.exact ? page.url() === want : page.url().toLowerCase().includes(want.toLowerCase())));
      if (!ok) throw fail(`The address is ${page.url()}, not ${p.exact ? '' : 'containing '}${want}.`);
      return;
    }
    case 'page': {
      const slug = norm(want);
      const ok = await poll(t, async () => {
        if (norm(decodeURIComponent(page.url())).replace(/[-_/]/g, ' ').includes(slug)) return true;
        if (norm(await page.title()).includes(slug)) return true;
        const snap = await snapshot(page);
        return snap.nodes.some((n) => n.role === 'heading' && norm(n.text || n.name).includes(slug));
      });
      if (!ok) throw fail(`This does not look like the ${want} page (address ${page.url()}, title ${JSON.stringify(await page.title())}).`);
      return;
    }
    case 'message': {
      const re = KINDS[p.kind ?? 'error'] ?? KINDS.error;
      const found = await poll(t, async () => {
        const msgs = (await page.evaluate(MESSAGES_JS)) as { text: string; cls: string }[];
        const hit = msgs.find((m) => re.test(m.text) || re.test(m.cls));
        if (hit) return { text: hit.text, flagged: false };
        // Some pages only mark the field (a red border, aria-invalid) and print nothing. For an error, that counts, with lower confidence.
        if (p.kind === 'error' || p.kind === 'validation' || p.kind === 'alert') {
          const fields = (await page.evaluate(FLAGGED_JS)) as string[];
          if (fields.length) return { text: fields.join(', '), flagged: true };
        }
        return undefined;
      });
      if (!found) throw fail(`No ${p.kind} message appeared, and no field was marked as invalid.`);
      if (found.flagged) {
        ctx.r.matchedAs = `field marked invalid: ${found.text}`;
        ctx.r.resolveConfidence = Math.min(ctx.r.resolveConfidence, 0.7);
        ctx.r.notes.push('The page marks the field as invalid but shows no message text. An error was counted as shown.');
      } else ctx.r.matchedAs = `message "${found.text}"`;
      return;
    }
    case 'no-message': {
      const re = KINDS[p.kind ?? 'error'] ?? KINDS.error;
      await sleep(400);
      const msgs = (await page.evaluate(MESSAGES_JS)) as { text: string; cls: string }[];
      const bad = msgs.find((m) => re.test(m.text) || re.test(m.cls));
      if (bad) throw fail(`A ${p.kind} message is showing: ${JSON.stringify(bad.text)}.`);
      if (p.kind === 'error' || p.kind === 'validation') {
        const fields = (await page.evaluate(FLAGGED_JS)) as string[];
        if (fields.length) throw fail(`A field is marked as invalid: ${fields.join(', ')}.`);
      }
      return;
    }
  }

  // Checks about one element.
  if (p.check === 'hidden') {
    const gone = await poll(t, async () => {
      const snap = await snapshot(page);
      const m = rank(snap.nodes, p.target ?? '', p.hint, 'see');
      return !m.best || m.best.score < 0.6;
    });
    if (!gone) throw fail(`"${p.target}" is still on the page.`);
    return;
  }
  let selector: string;
  try {
    ({ selector } = await locate(page, p, ctx, 'see'));
  } catch (e) {
    throw fail((e as Error).message);
  }
  const el = page.locator(selector).first();
  const state = async () => {
    switch (p.check) {
      case 'visible': return await el.isVisible();
      case 'enabled': return await el.isEnabled();
      case 'disabled': return await el.isDisabled();
      case 'checked': return await el.isChecked();
      case 'unchecked': return !(await el.isChecked());
      case 'editable': return await el.isEditable();
      case 'readonly': return !(await el.isEditable());
      case 'value': {
        const v = await el.inputValue();
        return v === want || norm(v).includes(norm(want));
      }
      default: return true;
    }
  };
  const ok = await poll(t, state);
  if (!ok) {
    const shown = p.check === 'value' ? ` (it holds ${JSON.stringify(await el.inputValue().catch(() => ''))})` : '';
    throw fail(`"${p.target}" is not ${p.check === 'value' ? `holding ${JSON.stringify(want)}` : p.check}${shown}.`);
  }
}
