/**
 * Runs plain-English test cases in a browser.
 *   node cli.js <cases.json>
 * Reads APP_URL, HEAL_DIR and HEAL_STORE from the environment (the web app sets them).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestCase } from '../cases/model.js';
import { runCases } from './runner.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: cli.js <cases.json>');
  process.exit(2);
}
const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: TestCase[] };
const healDir = process.env.HEAL_DIR ?? '.heal';
const appUrl = process.env.APP_URL;
if (!appUrl) {
  console.error('APP_URL is not set: give the link of the app to test.');
  process.exit(2);
}

try {
  const { results, passed } = await runCases({
    cases, appUrl, healDir, blockPrivate: process.env.HEAL_BLOCK_PRIVATE === '1', storeFile: process.env.HEAL_STORE ?? join(healDir, 'fingerprints.db'), log: (l) => console.log(l),
  });
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} test cases: ${count('passed')} passed, ${count('failed')} failed, ${count('skipped')} skipped${count('blocked') ? `, ${count('blocked')} blocked (a page would not load)` : ''}.`);
  process.exit(passed ? 0 : 1);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
