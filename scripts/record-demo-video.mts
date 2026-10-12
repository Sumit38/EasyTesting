/**
 * Records the landing-page demo video: a real browser driving the real EasyTesting app.
 *   node --import tsx scripts/record-demo-video.mts
 * Writes site/demo.webm and site/demo-poster.jpg. Captions and a cursor are drawn over the page so the video explains
 * itself without sound. Needs Chrome or Edge.
 */
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright-core';
import { launchBrowser } from '../src/exec/runner.js';
import { createApp } from '../src/server/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A throwaway server with sign-up switched on, like a hosted EasyTesting would have.
const data = mkdtempSync(join(tmpdir(), 'video-data-'));
const { server } = createApp({ dataDir: data, accounts: true, allowSignup: true, timeoutMs: 180_000 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// The first account is always the admin; make it before filming so the viewer sees a normal new-user sign-up.
await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-demo-password' }) });

// What is drawn over the page: a cursor, a click ripple, and a caption bar.
const OVERLAY = `(() => {
  const css = '#__cur{position:fixed;z-index:2147483647;width:24px;height:24px;border-radius:50%;background:rgba(29,122,85,.9);border:3px solid #fff;box-shadow:0 3px 12px rgba(0,0,0,.4);pointer-events:none;transform:translate(-50%,-50%);left:-60px;top:-60px;transition:transform .1s}'
    + '#__cur.down{transform:translate(-50%,-50%) scale(.65)}'
    + '#__cap{position:fixed;z-index:2147483646;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);max-width:82%;background:rgba(14,26,19,.94);color:#fff;font:700 24px/1.35 system-ui,Segoe UI,sans-serif;padding:15px 28px;border-radius:16px;box-shadow:0 12px 34px rgba(0,0,0,.4);opacity:0;transition:opacity .35s,transform .35s;text-align:center}'
    + '#__cap.on{opacity:1;transform:translateX(-50%)}#__cap small{display:block;font-weight:600;font-size:16px;opacity:.8;margin-top:3px}';
  const mk = () => {
    if (document.getElementById('__cur')) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    const cur = document.createElement('div'); cur.id = '__cur'; document.body.append(cur);
    const cap = document.createElement('div'); cap.id = '__cap'; document.body.append(cap);
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => cur.classList.add('down'), true);
    addEventListener('mouseup', () => cur.classList.remove('down'), true);
  };
  if (document.body) mk(); else addEventListener('DOMContentLoaded', mk);
  window.__cap = (title, sub) => { mk(); const c = document.getElementById('__cap'); if (!title) { c.classList.remove('on'); return; } c.innerHTML = ''; c.append(document.createTextNode(title)); if (sub) { const s = document.createElement('small'); s.textContent = sub; c.append(s); } c.classList.add('on'); };
})();`;

const browser = await launchBrowser(true);
const videoDir = join(data, 'video');
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } } });
await context.addInitScript(OVERLAY);
const page = await context.newPage();

const cap = async (title?: string, sub?: string) => { await page.evaluate(([t, s]) => (window as any).__cap(t, s), [title ?? '', sub ?? ''] as const); };
/** Glide the cursor to an element, then click it. */
async function click(target: Locator, pause = 350) {
  await target.scrollIntoViewIfNeeded();
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 28 });
  await sleep(pause);
  await target.click();
}
async function hover(target: Locator, ms = 900) {
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 22 });
  await sleep(ms);
}
const type = async (target: Locator, text: string) => { await click(target, 200); await target.pressSequentially(text, { delay: 60 }); };
const scroll = async (px: number, ms = 1100) => { await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), px); await sleep(ms); };

await page.goto(base + '/#/signup');
await page.mouse.move(640, 420);
await sleep(600);

// 1. A new person creates an account.
await cap('Get started in seconds', 'Create a free account, or sign in if you already have one');
await sleep(2800);
await click(page.locator('#auth .authtabs button', { hasText: 'Create account' }));
await sleep(500);
await type(page.getByPlaceholder('Your name'), 'Sam Taylor');
await type(page.getByPlaceholder('you@company.com'), 'sam@example.com');
await type(page.getByPlaceholder('At least 8 characters'), 'demo-password-1');
await sleep(500);
await click(page.locator('#auth .btn.primary'));
await page.waitForSelector('#view-home:not(.hidden)', { timeout: 15_000 });

// 2. Choose where to start.
await cap('Start from whatever you have', 'A use case, a spreadsheet of test cases, or test code');
await sleep(1500);
await hover(page.locator('a.path').nth(1), 900);
await hover(page.locator('a.path').nth(2), 800);
await click(page.locator('a.path').nth(0));
await page.waitForSelector('#view-usecases:not(.hidden)');

// 3. Describe the use case.
await cap('Describe what your app should do', 'In plain words. No special format needed');
await sleep(1200);
await click(page.getByRole('button', { name: 'Use the sample' }));
await sleep(2600);
await cap('Then press one button', 'EasyTesting writes the test cases for you');
await sleep(1500);
await click(page.getByRole('button', { name: /Generate test cases/ }));
await page.waitForSelector('#view-suite:not(.hidden) .case', { timeout: 20_000 });

// 4. Review them.
await cap('8 test cases, written for you', 'The normal path, mistakes people make, limits and alternate flows');
await sleep(2500);
await cap();
await sleep(700); // let the caption fade before taking the poster
mkdirSync(resolve('site'), { recursive: true });
await page.screenshot({ path: resolve('site', 'demo-poster.jpg'), type: 'jpeg', quality: 82 });
await cap('Every step shows how it was understood', 'and how sure we are, so nothing is a guess');
await scroll(520, 1500);
await scroll(320, 1800);
await cap('Edit anything in plain English, or download as Excel or CSV');
await scroll(-900, 1400);
await hover(page.getByRole('button', { name: /Excel/ }), 1600);
await cap('Add your app link and run');
await scroll(360, 1000);
await sleep(800);
await click(page.getByRole('button', { name: /Run these test cases/ }));

// 5. Watch it run.
await page.waitForSelector('#view-run:not(.hidden)', { timeout: 15_000 });
await cap('The test cases run in a real browser', 'one step at a time');
await sleep(2500);
await page.waitForFunction(() => /Passed|failed|Could not/i.test(document.getElementById('dStatus')?.textContent ?? ''), null, { timeout: 120_000 });
await sleep(1500);
await page.evaluate(() => window.scrollTo({ top: document.getElementById('runSteps')!.getBoundingClientRect().top + scrollY - 80, behavior: 'smooth' }));
await sleep(1200);
await cap('8 of 8 passed, with a confidence score', 'You see how sure we are, not just pass or fail');
await sleep(3500);
await cap('If a button changes later, the test can find it again', 'Instead of stopping with "element not found"');
await sleep(3200);

// 6. The report.
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
await sleep(900);
await click(page.locator('#viewReport'));
await page.waitForSelector('#view-report:not(.hidden) .tile', { timeout: 20_000 });
await cap('A report you can act on', 'Risk, coverage, bugs and what was never tested');
await sleep(3500);
await scroll(520, 1500);
await sleep(1600);
await scroll(520, 1500);
await sleep(1600);
await cap('EasyTesting', 'Describe it. We test it. Broken tests fix themselves.');
await sleep(3200);

const video = page.video()!;
await context.close();
const file = await video.path();
copyFileSync(file, resolve('site', 'demo.webm'));
await browser.close();
server.close();
console.log('Wrote site/demo.webm and site/demo-poster.jpg');
process.exit(0);
