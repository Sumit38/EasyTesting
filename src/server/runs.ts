import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, cpSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BugTracker, type Bug, type BugStatus, type Severity } from './bugs.js';
import { DEMO_FILES, DEMO_SCENARIOS_CSV } from './demo.js';
import { evidenceZip } from './evidence.js';
import { buildReport } from './report.js';
import { readCoverage, readResults, severityFromScenario, syntheticResult, withReporter } from './results.js';
import { AppDb } from './appdb.js';
import { parseScenarios, type Scenario } from './scenarios.js';
import { unzipSync, zipSync } from 'fflate';
import { applyInDir, loadRecords } from '../apply.js';
import type { HealRecord } from '../core.js';

export type Framework = 'playwright' | 'selenium' | 'custom';
/** How long a test-case run waits for the site: Normal 15 s per step, Slow 30 s, Very slow 60 s. */
export type Speed = 'normal' | 'slow' | 'very-slow';
export type RunStatus = 'queued' | 'installing' | 'running' | 'passed' | 'failed' | 'error' | 'timeout' | 'stopped';

export interface Run {
  id: string;
  name: string;
  framework: Framework;
  appUrl: string;
  command: string;
  install: boolean;
  status: RunStatus;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** Folder name of the project this run belongs to (from its name). Runs of one project share fingerprints, bugs and scenarios. */
  project: string;
  /** Which version of the sample site, for demo runs. */
  demo?: string;
  /** Id of the user who started the run (0 or absent when accounts are off). */
  owner?: number;
  /** 'cases' for runs of plain-English test cases made or uploaded in the app; absent for uploaded test projects. */
  kind?: 'cases';
  /** The suite a cases run belongs to. */
  suite?: number;
}

/** The command a tester would type, worked out from the project when they did not give one. */
export function inferCommand(cwd: string, framework: Framework): string {
  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  } catch {
    /* no package.json */
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test';
  if (framework === 'playwright' || deps['@playwright/test']) return 'npx playwright test';
  if (deps.mocha) return 'npx mocha';
  if (deps.jest) return 'npx jest';
  const entry = readdirSync(cwd).find((f) => /\.(test|spec)\.[cm]?[jt]s$/.test(f));
  return entry ? `node ${entry}` : 'npm test';
}

/** NODE_OPTIONS that load the healing hooks into every Node process the tests start. */
function healingNodeOptions(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = import.meta.url.endsWith('.js');
  const register = pathToFileURL(join(here, '..', 'auto', compiled ? 'register.js' : 'register.ts')).href;
  const tsx = compiled ? [] : [`--import ${pathToFileURL(join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href}`];
  return [...tsx, `--import ${register}`].join(' ');
}

const ACTIVE = ['queued', 'installing', 'running'];

let channelCache: Promise<string | undefined> | undefined;
/** The first browser Playwright can launch here: Chrome, then Edge, then its own Chromium. */
function browserChannel(): Promise<string | undefined> {
  channelCache ??= (async () => {
    const { chromium } = await import('playwright-core');
    for (const channel of ['chrome', 'msedge', undefined]) {
      try {
        await (await chromium.launch({ channel, headless: true })).close();
        return channel;
      } catch {
        /* try the next one */
      }
    }
    return undefined;
  })();
  return channelCache;
}

/** The command that runs plain-English test cases with the built-in executor. */
function casesCommand(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = import.meta.url.endsWith('.js');
  const q = (p: string) => `"${p.replace(/\\/g, '/')}"`;
  if (compiled) return `node ${q(join(here, '..', 'exec', 'cli.js'))} ${file}`;
  const tsx = pathToFileURL(join(here, '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href;
  return `node --import ${tsx} ${q(join(here, '..', 'exec', 'cli.ts'))} ${file}`;
}

export interface RunManagerOptions {
  dataDir: string;
  /** How many runs may execute at the same time; the rest wait as 'queued'. Default 3, or HEAL_MAX_RUNS. */
  maxConcurrent?: number;
  /** Kill a run that takes longer than this. */
  timeoutMs?: number;
  /** Test cases may only open public websites (not this machine, a private network or files). Turn on for any shared server. */
  blockPrivateTargets?: boolean;
  /** How many runs one person may have waiting or running at once. Default 3, or HEAL_MAX_USER_RUNS. */
  maxPerUser?: number;
  /** Finished runs older than this many days are deleted, with their screenshots and logs. Default 30, or HEAL_KEEP_DAYS; 0 keeps everything. */
  keepDays?: number;
}

/** Stores uploaded test projects, runs them with healing switched on, and reads back what was healed. */
export class RunManager {
  private readonly dir: string;
  private readonly timeoutMs: number;
  /** The application database. Shared with the web layer for accounts and test-case suites. */
  readonly app: AppDb;
  private readonly procs = new Map<string, ChildProcess>();
  /** Runs a person asked to stop: they end as 'stopped', not as failed. */
  private readonly stopping = new Set<string>();
  private readonly maxConcurrent: number;
  private active = 0;
  private readonly blockPrivate: boolean;
  readonly maxPerUser: number;
  private readonly waiting: (() => void)[] = [];

  constructor(opts: RunManagerOptions) {
    this.dir = resolve(opts.dataDir);
    // Slow sites with many cases take a while; a run that is truly stuck is still ended.
    this.timeoutMs = opts.timeoutMs ?? 45 * 60_000;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? (Number(process.env.HEAL_MAX_RUNS) || 3));
    this.blockPrivate = !!opts.blockPrivateTargets;
    this.maxPerUser = Math.max(1, opts.maxPerUser ?? (Number(process.env.HEAL_MAX_USER_RUNS) || 3));
    mkdirSync(join(this.dir, 'runs'), { recursive: true });
    this.app = new AppDb(join(this.dir, 'app.db'));
    this.app.importLegacy(this.dir);
    // A server restart leaves no process behind, so anything still marked active did not finish.
    for (const r of this.list()) {
      if (['queued', 'installing', 'running'].includes(r.status)) this.save({ ...r, status: 'error', finishedAt: new Date().toISOString() });
    }
    const keep = opts.keepDays ?? (process.env.HEAL_KEEP_DAYS === undefined ? 30 : Number(process.env.HEAL_KEEP_DAYS));
    if (keep > 0) {
      this.prune(keep);
      setInterval(() => this.prune(keep), 6 * 3_600_000).unref();
    }
  }

  /** Runs this person has waiting or running. */
  busyFor(owner: number | undefined): number {
    return owner ? this.list().filter((r) => r.owner === owner && ACTIVE.includes(r.status)).length : 0;
  }

  /** Deletes finished runs older than `days`, so screenshots and logs do not fill the disk. Returns how many went. */
  prune(days: number): number {
    const cutoff = Date.now() - days * 86_400_000;
    let n = 0;
    for (const r of this.list()) {
      if (ACTIVE.includes(r.status) || Date.parse(r.finishedAt ?? r.createdAt) >= cutoff) continue;
      rmSync(this.runDir(r.id), { recursive: true, force: true });
      n++;
    }
    return n;
  }

  /** Starts a run in the background. A failure to start is logged, never left as an unhandled rejection that would end the server. */
  private launch(run: Run, extraEnv: NodeJS.ProcessEnv = {}) {
    this.start(run, extraEnv).catch((e) => {
      if (!this.get(run.id)) return; // deleted while it waited
      console.error(`[runs] ${run.id} could not run: ${(e as Error).message}`);
      try {
        this.finish(run, 'error');
      } catch {
        /* the run folder is gone */
      }
    });
  }

  private runDir = (id: string) => join(this.dir, 'runs', id);
  private projectDir = (id: string) => join(this.runDir(id), 'project');
  private healDir = (id: string) => join(this.runDir(id), 'heal');
  /** Projects are per user: two testers can both have a project called 'Checkout' without sharing bugs or fingerprints. */
  private projectKey = (name: string, owner?: number) => (owner ? `u${owner}-` : '') + this.slug(name);
  private slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';
  private projectFolder = (slug: string) => {
    mkdirSync(join(this.dir, 'projects', slug), { recursive: true });
    return join(this.dir, 'projects', slug);
  };
  private storeFile = (slug: string) => join(this.projectFolder(slug), 'fingerprints.db');
  /** The bugs of one project. */
  readonly tracker = (slug: string) => new BugTracker(this.app.db, slug);
  /** Called once a finished run's results have updated its project's bugs; the web layer reports re-tests to linked tickets. */
  onReconciled?: (run: Run, bugs: Bug[]) => void;
  logFile = (id: string) => join(this.runDir(id), 'run.log');
  private save(run: Run) {
    writeFileSync(join(this.runDir(run.id), 'run.json'), JSON.stringify(run, null, 2));
  }

  list(): Run[] {
    return readdirSync(join(this.dir, 'runs'))
      .map((id) => this.get(id))
      .filter((r): r is Run => !!r)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Run | undefined {
    if (!/^[a-f0-9]{12}$/.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.runDir(id), 'run.json'), 'utf8')) as Run;
    } catch {
      return undefined;
    }
  }

  heals(id: string): HealRecord[] {
    return existsSync(this.healDir(id)) ? loadRecords(this.healDir(id)) : [];
  }

  /** Unpacks an uploaded zip (or a single file) and starts the run in the background. */
  create(input: { name: string; framework: Framework; appUrl: string; command?: string; install: boolean; upload: Buffer; filename: string; owner?: number }): Run {
    const id = randomBytes(6).toString('hex');
    const run: Run = {
      id,
      name: input.name || basename(input.filename) || 'Untitled run',
      framework: input.framework,
      appUrl: input.appUrl,
      command: input.command?.trim() ?? '',
      install: input.install,
      status: 'queued',
      createdAt: new Date().toISOString(),
      project: '',
      owner: input.owner || undefined,
    };
    run.project = this.projectKey(run.name, input.owner);
    mkdirSync(this.projectDir(id), { recursive: true });
    mkdirSync(this.healDir(id), { recursive: true });
    this.save(run);
    try {
      if (input.filename.toLowerCase().endsWith('.zip')) extractZip(input.upload, this.projectDir(id));
      else writeFileSync(join(this.projectDir(id), basename(input.filename)), input.upload);
    } catch (e) {
      this.finish(run, 'error');
      writeFileSync(this.logFile(id), `Could not unpack the upload: ${(e as Error).message}\n`);
      return this.get(id)!;
    }
    this.launch(run);
    return run;
  }

  /** The built-in demo: a Playwright Test project against the sample site served by this app. `version` is the state of the site. */
  async createDemo(appUrl: string, version: string, owner?: number): Promise<Run> {
    const id = randomBytes(6).toString('hex');
    const name = 'Demo: Acme account settings';
    const run: Run = {
      id, name, framework: 'playwright', appUrl, command: 'node node_modules/@playwright/test/cli.js test',
      install: false, status: 'queued', createdAt: new Date().toISOString(), project: this.projectKey(name, owner), demo: version, owner: owner || undefined,
    };
    const project = this.projectDir(id);
    mkdirSync(project, { recursive: true });
    mkdirSync(this.healDir(id), { recursive: true });
    for (const [file, text] of Object.entries(DEMO_FILES)) writeFileSync(join(project, file), text);
    // The tests import @playwright/test; point node_modules at the copy this tool already ships with.
    const modules = dirname(dirname(dirname(createRequire(import.meta.url).resolve('@playwright/test/package.json'))));
    symlinkSync(modules, join(project, 'node_modules'), 'junction');
    if (!this.app.hasScenarios(run.project)) this.app.setScenarios(run.project, DEMO_SCENARIOS_CSV, parseScenarios(DEMO_SCENARIOS_CSV));
    this.save(run);
    this.launch(run, { DEMO_CHANNEL: (await browserChannel()) ?? '' });
    return run;
  }

  /** Starts a run of plain-English test cases with the built-in executor. */
  createCases(input: { title: string; appUrl: string; cases: import('../cases/model.js').TestCase[]; owner?: number; suite?: number; stopOnFail?: boolean; speed?: Speed }): Run {
    const id = randomBytes(6).toString('hex');
    const run: Run = {
      id, name: input.title, framework: 'custom', appUrl: input.appUrl, command: 'Built-in test-case runner', install: false, status: 'queued',
      createdAt: new Date().toISOString(), project: this.projectKey(input.title, input.owner), owner: input.owner || undefined, kind: 'cases', suite: input.suite,
    };
    mkdirSync(this.projectDir(id), { recursive: true });
    mkdirSync(this.healDir(id), { recursive: true });
    writeFileSync(join(this.projectDir(id), 'cases.json'), JSON.stringify({ title: input.title, appUrl: input.appUrl, cases: input.cases, stopOnFail: !!input.stopOnFail, speed: input.speed ?? 'normal' }, null, 2));
    this.save(run);
    this.launch(run);
    return run;
  }

  /** Step-by-step results of a test-case run: what each step was understood as, how sure, what happened. */
  steps(id: string): { cases: unknown[] } | undefined {
    try {
      return JSON.parse(readFileSync(join(this.healDir(id), 'steps.json'), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** Path of a picture of a step, or undefined when the name is not a plain file name. */
  screenshot(id: string, file: string): string | undefined {
    if (!/^[\w.-]+\.(?:png|jpg)$/.test(file)) return undefined;
    const p = join(this.healDir(id), 'shots', file);
    return existsSync(p) ? p : undefined;
  }

  /** Every picture of a test-case run, with a summary and the before/after of bugs it re-tested, as one zip. */
  screenshotsZip(id: string) {
    const run = this.get(id);
    const data = this.steps(id) as { cases: Parameters<typeof evidenceZip>[0]['cases'] } | undefined;
    if (!run || !data?.cases?.length) return undefined;
    this.reconcile(id);
    const retested = this.tracker(run.project).list().filter((b) => b.retest?.runId === id);
    return evidenceZip({
      runId: id, title: run.name, appUrl: run.appUrl, startedAt: run.createdAt, status: run.status, cases: data.cases, shotsDir: join(this.healDir(id), 'shots'), retested,
      earlier: (other) => {
        const old = this.get(other);
        const cases = old && old.project === run.project ? (this.steps(other) as { cases: Parameters<typeof evidenceZip>[0]['cases'] } | undefined)?.cases : undefined;
        return cases ? { cases, shotsDir: join(this.healDir(other), 'shots') } : undefined;
      },
    });
  }

  /** Runs a finished run's tests again, on the same app link. This is how a fixed bug gets re-tested. */
  async rerun(id: string): Promise<Run | undefined> {
    const old = this.get(id);
    if (!old) return undefined;
    if (old.demo) return this.createDemo(old.appUrl, old.demo, old.owner);
    if (old.kind === 'cases') {
      const saved = JSON.parse(readFileSync(join(this.projectDir(id), 'cases.json'), 'utf8')) as { title: string; cases: import('../cases/model.js').TestCase[]; stopOnFail?: boolean; speed?: Speed };
      return this.createCases({ title: old.name, appUrl: old.appUrl, cases: saved.cases, owner: old.owner, suite: old.suite, stopOnFail: saved.stopOnFail, speed: saved.speed });
    }
    const nid = randomBytes(6).toString('hex');
    const run: Run = { ...old, id: nid, status: 'queued', createdAt: new Date().toISOString(), finishedAt: undefined, exitCode: undefined };
    mkdirSync(this.runDir(nid), { recursive: true });
    mkdirSync(this.healDir(nid), { recursive: true });
    cpSync(this.projectDir(id), this.projectDir(nid), { recursive: true, filter: (src) => basename(src) !== 'node_modules' });
    this.save(run);
    this.launch(run);
    return run;
  }

  /** Counts for the dashboard: how many locator failures there were and what became of them. */
  summary(id: string) {
    const heals = this.heals(id);
    const n = (...s: string[]) => heals.filter((h) => s.includes(h.status)).length;
    return { failures: heals.length, healed: n('verified', 'patched'), refused: n('refused'), failed: n('failed-verification'), applied: n('patched') };
  }

  private finish(run: Run, status: RunStatus, exitCode?: number | null) {
    this.procs.delete(run.id);
    this.save({ ...run, status, exitCode, finishedAt: new Date().toISOString() });
  }

  /** Starts a run when a slot is free. Until then it stays queued. */
  private async start(run: Run, extraEnv: NodeJS.ProcessEnv = {}) {
    if (this.active >= this.maxConcurrent) await new Promise<void>((go) => this.waiting.push(go));
    this.active++;
    try {
      // A run deleted or stopped while it waited has nothing left to run.
      if (this.get(run.id)?.status === 'queued') await this.execute(run, extraEnv);
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async execute(run: Run, extraEnv: NodeJS.ProcessEnv) {
    const log = createWriteStream(this.logFile(run.id), { flags: 'a' });
    log.on('error', () => undefined); // a full disk must not end the server
    // Zips often wrap everything in one top-level folder; run from there.
    const cwd = projectRoot(this.projectDir(run.id));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HEAL_DIR: this.healDir(run.id),
      // Runs with the same name share fingerprints, so a green run teaches the next one what to look for.
      HEAL_STORE: this.storeFile(run.project),
      APP_URL: run.appUrl,
      BASE_URL: run.appUrl,
      CI: '1',
      ...extraEnv,
    };
    if (run.kind === 'cases') {
      // The built-in runner needs none of the server's secrets, and a test case must never be able to read them.
      delete env.ANTHROPIC_API_KEY;
      delete env.HEAL_TOKEN;
      if (this.blockPrivate) env.HEAL_BLOCK_PRIVATE = '1';
    }
    const exec = (command: string, healing = false) =>
      new Promise<{ code: number | null; timedOut: boolean }>((done) => {
        const childEnv = healing ? { ...env, NODE_OPTIONS: [process.env.NODE_OPTIONS, healingNodeOptions()].filter(Boolean).join(' ') } : env;
        const child = spawn(command, { cwd, env: childEnv, shell: true, windowsHide: true });
        this.procs.set(run.id, child);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, this.timeoutMs);
        child.stdout?.pipe(log, { end: false });
        child.stderr?.pipe(log, { end: false });
        child.on('error', (e) => log.write(`\n[runner] ${e.message}\n`));
        child.on('close', (code) => {
          clearTimeout(timer);
          done({ code, timedOut });
        });
      });

    try {
      if (run.kind === 'cases') {
        this.save({ ...run, status: 'running' });
        log.write(`[runner] Running test cases against ${run.appUrl}\n`);
        const res = await exec(casesCommand('cases.json'));
        return this.endRun(run, log, res.timedOut ? 'timeout' : res.code === 0 ? 'passed' : 'failed', res.code);
      }
      if (run.install && existsSync(join(cwd, 'package.json'))) {
        this.save({ ...run, status: 'installing' });
        log.write('[runner] npm install\n');
        const res = await exec('npm install --no-audit --no-fund');
        if (res.code !== 0) return this.endRun(run, log, res.timedOut ? 'timeout' : 'error', res.code);
      }
      if (!run.command) run.command = inferCommand(cwd, run.framework);
      this.save({ ...run, status: 'running' });
      log.write(`[runner] ${run.command}  (APP_URL=${run.appUrl}, self-healing on)\n`);
      const res = await exec(withReporter(run.command, cwd), true);
      this.endRun(run, log, res.timedOut ? 'timeout' : res.code === 0 ? 'passed' : 'failed', res.code);
    } catch (e) {
      log.write(`[runner] ${(e as Error).message}\n`);
      this.endRun(run, log, 'error');
    }
  }

  private endRun(run: Run, log: NodeJS.WritableStream, status: RunStatus, code?: number | null) {
    if (this.stopping.delete(run.id)) status = 'stopped';
    log.end(`\n[runner] finished: ${status}${code === undefined || code === null ? '' : ` (exit ${code})`}\n`);
    this.finish(run, status, code);
    // Update the project's bug list from this run's results, once the log is on disk.
    log.once('finish', () => {
      try {
        this.reconcile(run.id);
      } catch {
        /* a reporting problem must not break the run */
      }
    });
  }

  /** The tests of a run: from the reporter, or the whole run as one test when no reporter could be used. */
  private testsOf(id: string) {
    const run = this.get(id)!;
    const real = readResults(this.healDir(id));
    if (real) {
      // Absolute paths contain the run id; relative ones identify the same test across runs.
      const root = projectRoot(this.projectDir(id));
      for (const t of real.tests) if (t.file) t.file = relative(root, t.file).replace(/\\/g, '/');
      return real;
    }
    const log = existsSync(this.logFile(id)) ? readFileSync(this.logFile(id), 'utf8') : '';
    return syntheticResult(run.name, run.status, log);
  }

  private reconcile(id: string) {
    const run = this.get(id);
    if (!run || ACTIVE.includes(run.status)) return;
    // A test project killed part-way has no results of its own; without them the whole run would be filed as one failure.
    if (run.status === 'stopped' && !readResults(this.healDir(id))) return;
    const marker = join(this.healDir(id), 'reconciled');
    if (existsSync(marker)) return;
    const scenarios = this.scenarios(run.project).scenarios;
    const bugs = this.tracker(run.project).reconcile(id, this.testsOf(id).tests, (t) => severityFromScenario(scenarios, t.title));
    // A report is a record of how things stood after this run, so keep the bug list as it was then.
    writeFileSync(join(this.healDir(id), 'bugs-snapshot.json'), JSON.stringify(bugs));
    writeFileSync(marker, new Date().toISOString());
    try {
      this.onReconciled?.(run, bugs);
    } catch {
      /* reporting elsewhere must not break the run */
    }
  }

  scenarios(project: string): { csv: string; scenarios: Scenario[] } {
    return this.app.getScenarios(project);
  }

  /** Saves the project's planned scenarios from CSV text. */
  setScenarios(id: string, csv: string): Scenario[] {
    const run = this.get(id);
    if (!run) throw new Error('No such run.');
    const scenarios = parseScenarios(csv);
    this.app.setScenarios(run.project, csv, scenarios);
    return scenarios;
  }

  /** A person changes a bug of this run's project. */
  updateBug(id: string, bugId: string, change: { status?: BugStatus; severity?: Severity; note?: string }) {
    const run = this.get(id);
    return run ? this.tracker(run.project).update(bugId, change) : undefined;
  }

  /** The full quality report for a run: results, coverage, scenarios, bugs, density and residual risk. */
  report(id: string) {
    const run = this.get(id);
    if (!run) return undefined;
    this.reconcile(id);
    const { tests, note } = this.testsOf(id);
    const latestId = this.list().find((r) => r.project === run.project)?.id ?? id;
    const snapshot = join(this.healDir(id), 'bugs-snapshot.json');
    const bugs = latestId !== id && existsSync(snapshot) ? (JSON.parse(readFileSync(snapshot, 'utf8')) as Bug[]) : this.tracker(run.project).list();
    // For plain-English test cases: how sure the tool is of the results, and how well it understood the steps.
    let guided: { confidence: number; understanding: number; cases: number } | undefined;
    if (run.kind === 'cases') {
      const done = ((this.steps(id)?.cases ?? []) as { status: string; confidence: number; understanding: number }[]).filter((c) => c.status !== 'skipped');
      const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
      guided = { confidence: mean(done.map((c) => c.confidence)), understanding: mean(done.map((c) => c.understanding)), cases: done.length };
    }
    return {
      run: { ...run, ...this.summary(id) },
      guided,
      isLatest: latestId === id,
      latestId,
      ...buildReport({
        runId: id, tests, resultsNote: note, coverage: readCoverage(this.healDir(id)),
        scenarios: this.scenarios(run.project).scenarios, bugs, heals: this.heals(id),
      }),
    };
  }

  /**
   * Stops a run. A queued run never starts. A test-case run is asked to stop: the step in progress finishes, finished cases keep
   * their results and the rest are reported as not run; if it has not ended within 20 seconds it is ended by force. A test
   * project is ended at once.
   */
  stop(id: string): boolean {
    const run = this.get(id);
    if (!run || !ACTIVE.includes(run.status)) return false;
    const p = this.procs.get(id);
    if (!p) {
      this.save({ ...run, status: 'stopped', finishedAt: new Date().toISOString() });
      return true;
    }
    this.stopping.add(id);
    if (run.kind === 'cases') {
      writeFileSync(join(this.healDir(id), 'stop'), new Date().toISOString());
      setTimeout(() => this.procs.get(id) === p && killTree(p), 20_000).unref();
    } else killTree(p);
    return true;
  }

  /** Rewrites the uploaded test files for verified heals. `approve` lists ids below the auto level that a person accepted. */
  apply(id: string, approve: string[], only?: string[]): HealRecord[] {
    return applyInDir(this.healDir(id), { approve, only });
  }

  /** The project as it is now, patched files included. */
  zip(id: string): Buffer {
    const root = projectRoot(this.projectDir(id));
    const files: Record<string, Uint8Array> = {};
    addDir(files, root, root);
    return Buffer.from(zipSync(files));
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.stop(id);
    rmSync(this.runDir(id), { recursive: true, force: true });
    return true;
  }
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGKILL');
}

const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** Extracts a zip, refusing oversized archives and any entry that would land outside the target folder (zip-slip). */
function extractZip(data: Buffer, target: string) {
  const root = resolve(target);
  let entries = 0;
  let total = 0;
  // The filter runs on directory metadata before anything is inflated, so a decompression bomb is rejected cheaply.
  const files = unzipSync(data, {
    filter: (f) => {
      total += f.originalSize;
      if (++entries > MAX_ENTRIES || total > MAX_UNPACKED_BYTES) throw new Error('zip is too large when unpacked');
      return !f.name.split(/[\\/]/).includes('node_modules');
    },
  });
  for (const [name, bytes] of Object.entries(files)) {
    const dest = resolve(root, name);
    if (dest !== root && !dest.startsWith(root + sep)) throw new Error(`unsafe path in zip: ${name}`);
    if (name.endsWith('/')) continue;
    mkdirSync(resolve(dest, '..'), { recursive: true });
    writeFileSync(dest, bytes);
  }
}

/** The folder that holds the tests: the extraction folder, or its single top-level directory. */
function projectRoot(dir: string): string {
  const items = readdirSync(dir, { withFileTypes: true }).filter((d) => d.name !== '__MACOSX');
  return items.length === 1 && items[0].isDirectory() ? join(dir, items[0].name) : dir;
}

function addDir(out: Record<string, Uint8Array>, root: string, dir: string) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.name === 'node_modules') continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) addDir(out, root, full);
    else out[full.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/')] = readFileSync(full);
  }
}
