#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyInDir, loadRecords } from './apply.js';
import type { HealRecord } from './healer.js';
import { writeReport } from './report.js';

const HELP = `easytesting - test cases, test runs and self-healing locators (the older command name "heal" also works)

  easytesting run [--dir .heal] -- <test command>   run your tests; heals are recorded
  easytesting report [--dir .heal]                  list heals and write .heal/report.html
  easytesting apply [--dir .heal] [--approve id,id] [--min-confidence 0.8]
                                             rewrite test files for verified heals
  easytesting serve [--port 4173] [--host 127.0.0.1] [--data .heal-server] [--no-login] [--token secret] [--https] [--trust-proxy] [--no-code-uploads] [--signup]
                                             web app: upload tests, run them, review and apply heals
  easytesting pr [--dir .heal] [--approve id,id] [--branch name] [--no-push] [--no-pr]
                                             apply, commit on a branch, push, open a pull request

Only heals whose test then passed are ever applied. Heals below the auto level
need --approve <id> (or --min-confidence) so a person chooses them.
`;

function flags(args: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const list = (v: string | boolean | undefined) => (typeof v === 'string' ? v.split(',').filter(Boolean) : undefined);

function summary(records: HealRecord[]): string {
  if (!records.length) return 'No heals recorded.';
  const lines = records.map(
    (r) => `${r.id}  ${r.verdict.padEnd(7)} ${r.confidence.toFixed(2)}  ${r.status.padEnd(19)} ${r.test}: ${r.oldSelector} -> ${r.newSelector ?? '(none)'}  [${r.reason}]`,
  );
  const count = (s: string) => records.filter((r) => r.status === s).length;
  return `${lines.join('\n')}\n\n${records.length} lookup failures: ${count('verified') + count('patched')} healed and verified, ${count('refused')} refused, ${count('failed-verification')} failed verification.`;
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const dashIdx = rest.indexOf('--');
  const own = dashIdx === -1 ? rest : rest.slice(0, dashIdx);
  const f = flags(own);
  const dir = resolve(typeof f.dir === 'string' ? f.dir : '.heal');

  if (cmd === 'run') {
    const testCmd = dashIdx === -1 ? [] : rest.slice(dashIdx + 1);
    if (!testCmd.length) {
      console.error('heal run needs a test command after --, for example: heal run -- npx playwright test');
      return 2;
    }
    rmSync(join(dir, 'records'), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const res = spawnSync(testCmd[0], testCmd.slice(1), { stdio: 'inherit', env: { ...process.env, HEAL_DIR: dir } });
    const records = loadRecords(dir);
    console.log('\n' + summary(records));
    writeReport(records, join(dir, 'report.html'));
    return res.status ?? 1;
  }
  if (cmd === 'serve') {
    const host = typeof f.host === 'string' ? f.host : process.env.HOST || '127.0.0.1';
    const token = typeof f.token === 'string' ? f.token : process.env.HEAL_TOKEN;
    const accounts = !f['no-login'];
    if (host !== '127.0.0.1' && host !== 'localhost' && !accounts && !token) {
      console.error('Refusing to listen on a non-loopback address with --no-login unless --token is set: the server runs uploaded code.');
      return 2;
    }
    const port = typeof f.port === 'string' ? Number(f.port) : Number(process.env.PORT) || 4173;
    // One bad request or a full disk must not take the whole server, and everyone's runs, down with it.
    process.on('unhandledRejection', (e) => console.error('[server] unhandled rejection:', e));
    process.on('uncaughtException', (e) => console.error('[server] uncaught exception:', e));
    const on = (v: string | undefined) => /^(on|1|yes|true)$/i.test(v ?? '');
    const https = !!f.https || process.env.HEAL_HTTPS === '1';
    const loopback = host === '127.0.0.1' || host === 'localhost';
    void import('./server/index.js').then(({ serve }) =>
      serve({ port, host, token, accounts, secureCookies: https,
        // Behind an HTTPS proxy every visitor arrives from the proxy's address unless the proxy's headers are read.
        trustProxy: !!f['trust-proxy'] || on(process.env.HEAL_TRUST_PROXY) || (https && process.env.HEAL_TRUST_PROXY !== '0'),
        // A server other people reach must not let a test open its own files or private network. Always on unless it is local.
        blockPrivateTargets: process.env.HEAL_BLOCK_PRIVATE === '0' ? false : accounts && (!loopback || on(process.env.HEAL_BLOCK_PRIVATE)),
        allowSignup: !!f.signup || /^(on|1|yes|true)$/i.test(process.env.HEAL_SIGNUP ?? ''),
        allowCodeUploads: !f['no-code-uploads'] && !/^(off|0|no|false)$/i.test(process.env.HEAL_CODE_UPLOADS ?? ''), dataDir: typeof f.data === 'string' ? f.data : '.heal-server' }).then(() => {
        console.log(`EasyTesting web app: http://${host}:${port}${accounts ? '' : token ? `/?token=${token}` : ''}`);
        if (accounts) console.log('Open it and create the first account: that person becomes the admin and can add everyone else.');
      }),
    );
    return -1; // keep running
  }
  if (cmd === 'report') {
    const records = loadRecords(dir);
    console.log(summary(records));
    writeReport(records, join(dir, 'report.html'));
    return 0;
  }
  if (cmd === 'apply' || cmd === 'pr') {
    const minConfidence = typeof f['min-confidence'] === 'string' ? Number(f['min-confidence']) : undefined;
    const done = applyInDir(dir, { approve: list(f.approve), minConfidence });
    const patched = done.filter((r) => r.status === 'patched');
    for (const r of done) console.log(`${r.status === 'patched' ? 'patched     ' : 'needs review'} ${r.file}: ${r.oldSelector} -> ${r.newSelector}${r.status === 'patched' ? '' : ` (${r.reason})`}`);
    if (!patched.length) {
      console.log('Nothing to apply. Heals must be verified, and below-auto ones need --approve <id>.');
      return 0;
    }
    writeReport(loadRecords(dir), join(dir, 'report.html'));
    if (cmd === 'apply') return 0;
    return openPr(patched, dir, f);
  }
  console.log(HELP);
  return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
}

function openPr(patched: HealRecord[], dir: string, f: Record<string, string | boolean>): number {
  const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const branch = typeof f.branch === 'string' ? f.branch : `heal/${new Date().toISOString().slice(0, 10)}-${patched[0].id}`;
  const files = [...new Set(patched.map((r) => r.file!))];
  git('checkout', '-b', branch);
  git('add', '--', ...files);
  const title = `Heal ${patched.length} locator${patched.length === 1 ? '' : 's'} broken by UI changes`;
  const body = [
    'Locators updated by the self-healing runner. Each heal passed its test before being applied.',
    '',
    '| Test | Old locator | New locator | Confidence | Approved by |',
    '| --- | --- | --- | --- | --- |',
    ...patched.map((r) => `| ${r.test} | \`${r.oldSelector}\` | \`${r.newSelector}\` | ${r.confidence.toFixed(2)} | ${r.verdict === 'auto' ? 'auto level' : 'a person (--approve)'} |`),
    '',
    'Review each row: the tool matched elements by role, name, structure and position, so confirm the new locator targets the intended element.',
  ].join('\n');
  git('commit', '-m', `${title}\n\n${patched.map((r) => `- ${r.test}: ${r.oldSelector} -> ${r.newSelector}`).join('\n')}`);
  console.log(`Committed on branch ${branch}.`);
  if (f['no-push']) return 0;
  git('push', '-u', 'origin', branch);
  if (f['no-pr']) return 0;
  const bodyFile = join(dir, 'pr-body.md');
  writeFileSync(bodyFile, body);
  try {
    execFileSync('gh', ['pr', 'create', '--title', title, '--body-file', bodyFile, '--draft'], { stdio: 'inherit' });
  } catch {
    console.error('Branch pushed, but `gh pr create` failed. Open the pull request manually; the body is in ' + bodyFile);
    return 1;
  }
  return 0;
}

const code = main(process.argv.slice(2));
if (code >= 0) process.exit(code);
