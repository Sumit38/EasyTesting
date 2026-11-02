import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TestCase } from '../src/cases/model.js';
import { generateCases } from '../src/cases/generate.js';
import { closesPopup, describeStep, parseStep } from '../src/cases/steps.js';
import { runCases } from '../src/exec/runner.js';

describe('reading "close the pop-up" steps', () => {
  it('understands the ways testers ask to close a pop-up', () => {
    for (const s of [
      'Close the popup', 'Close the login pop-up', 'Close the pop up window', 'Close the dialog box.', 'Dismiss the cookie banner if it appears',
      'Close the login popup if it is displayed', 'Skip the login popup by clicking the cross icon', 'Click on the cross sign', 'Click on the cross sign to skip the mobile number popup',
      'Click the X icon on the popup', 'Tap ✕', 'Click "✕"', 'Click the close button', 'Click on the x mark of the login window',
    ]) {
      const p = parseStep(s);
      assert.deepEqual([p.action, p.hint], ['click', 'close'], s);
      assert.ok(p.confidence >= 0.9, s);
      assert.equal(describeStep(p), 'Close the pop-up (✕), if one is showing');
    }
  });
  it('leaves other steps alone', () => {
    assert.deepEqual([parseStep('Click the Close Account button').target, parseStep('Click the Close Account button').hint], ['Close Account', 'button']);
    assert.equal(parseStep('Verify the popup is displayed').action, 'verify');
    assert.equal(closesPopup('Cancel the order'), false);
    assert.equal(closesPopup('Click the Login button'), false);
  });
  it('turns "the user closes the login popup" in a use case into a step', () => {
    const g = generateCases('Use case: Search\nMain flow:\n1. The user opens the home page.\n2. The user closes the login popup.\n3. The user searches for "laptop".\n4. The system displays the search results.');
    assert.ok(g.cases[0].steps.includes('Close the pop-up'), JSON.stringify(g.cases[0].steps));
  });
});

/** Flipkart-like pages: a login pop-up that comes a moment after the page, closed only by a bare ✕ with no name. */
const OVERLAY = `<div class="xYz" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center">
  <div style="background:#fff;width:500px;height:300px;position:relative"><span role="button" class="b3wT" style="position:absolute;right:-40px;top:0;color:#fff;cursor:pointer;font-size:24px" onclick="this.closest('.xYz').remove()">✕</span>
  <p>Enter your phone number</p><input placeholder="Phone Number"></div></div>`;
const PAGES: Record<string, string> = {
  '/shop': `<body><h1>Shop</h1><input placeholder="Search products" value="old"><span role="button" style="cursor:pointer" onclick="this.previousElementSibling.value=''">×</span>
    <a href="/cart" style="position:absolute;top:10px;right:10px">Cart</a></body>
    <script>setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(OVERLAY)}), 1200)</script>`,
  '/cart': `<body><h1>Your cart</h1></body>`,
  '/plain': `<body><h1>No pop-ups here</h1></body>`,
};

describe('closing pop-ups during a run', () => {
  let site: Server;
  let origin = '';
  before(async () => {
    site = createServer((req, res) => {
      const page = PAGES[new URL(req.url ?? '/', 'http://x').pathname];
      if (!page) { res.writeHead(404); return void res.end('no'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Test shop</title></head>${page}</html>`);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  const one = async (steps: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'popup-'));
    const cases: TestCase[] = [{ id: 'TC-1', title: 't', steps, expected: '' }];
    const { results } = await runCases({ cases, appUrl: origin + '/shop', healDir: dir, storeFile: join(dir, 'fp.db'), stepTimeout: 5000 });
    return results[0];
  };
  const why = (r: Awaited<ReturnType<typeof one>>) => JSON.stringify(r.steps.map((s) => [s.text, s.status, s.matchedAs, s.error, s.notes]));

  it('waits for the late pop-up and closes it with its bare ✕, not the × that clears the search box', async () => {
    const r = await one(['Open "/shop"', 'Click on the cross sign of the login popup', 'Verify "Enter your phone number" is not displayed', 'Verify the Search products field contains "old"']);
    assert.equal(r.status, 'passed', why(r));
    assert.match(r.steps[1].matchedAs ?? '', /✕/);
  });

  it('closes a pop-up the case never mentioned when it covers what a step clicks', async () => {
    const r = await one(['Open "/shop"', 'Wait 2 seconds', 'Click on Cart', 'Verify "Your cart" is displayed']);
    assert.equal(r.status, 'passed', why(r));
    assert.match(r.steps[2].notes.join(' '), /A pop-up was covering "Cart", so it was closed first/);
  });

  it('does not fail when the pop-up does not show up this time', async () => {
    const r = await one(['Open "/plain"', 'Close the popup if it appears', 'Verify "No pop-ups here" is displayed']);
    assert.equal(r.status, 'passed', why(r));
    assert.match(r.steps[1].notes.join(' '), /No pop-up showed up this time/);
  });
});
