import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiConfigured, AI_MODEL, defaultClient, generate, improveSteps, AiError } from '../cases/ai.js';
import { casesToRows, COLUMN_WIDTHS, detectMapping, FIELDS, hasHeaderRow, rowsToCases, type Mapping, type TestCase } from '../cases/model.js';
import { describeStep, parseStep } from '../cases/steps.js';
import { writeCsv } from './csv.js';
import { readSheet } from './sheets.js';
import { SuiteStore, type Suite } from './suites.js';
import { writeXlsx } from './xlsx.js';
import { randomBytes } from 'node:crypto';
import { Auth, AuthError, clearCookie, cookie, COOKIE, sessionCookie, type User } from './auth.js';
import { blockedReason } from '../exec/guard.js';
import { decodeText } from '../cases/decode.js';
import { IntegrationError, Integrations, type Tool } from './integrations.js';
import { DEMO_TEST_DATA, DEMO_USE_CASE, demoPage } from './demo.js';
import { RunManager, type Framework } from './runs.js';

export interface ServerOptions {
  port?: number;
  /** Interface to listen on. Defaults to loopback: the server runs uploaded code, so do not expose it to a network. */
  host?: string;
  dataDir?: string;
  /** If set, every /api request must send `Authorization: Bearer <token>`. */
  token?: string;
  /** Require people to sign in with an account. The first account created becomes the admin. */
  accounts?: boolean;
  /** Mark the session cookie Secure (set this when serving over HTTPS). */
  secureCookies?: boolean;
  /** Let anyone create their own tester account from the sign-in screen. Off by default: accounts are made by an admin. */
  allowSignup?: boolean;
  /** Allow uploading test code (Playwright/Selenium projects), which runs on this machine. Turn off on a shared server. Default true. */
  allowCodeUploads?: boolean;
  /** How many runs may execute at once. */
  maxConcurrent?: number;
  /** How many runs one person may have waiting or running. */
  maxPerUser?: number;
  /** The server sits behind a proxy (Railway, Render, a load balancer): take the visitor's address from the proxy's headers, not the connection. */
  trustProxy?: boolean;
  /** Test cases may only open public websites. Turn on for any server other people use. */
  blockPrivateTargets?: boolean;
  timeoutMs?: number;
  maxUploadBytes?: number;
  /** Tests only: a stand-in for Jira and Azure DevOps. */
  integrationFetch?: typeof fetch;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMEWORKS: Framework[] = ['playwright', 'selenium', 'custom'];
const ACTIVE_STATUS = ['queued', 'installing', 'running'];

export function createApp(opts: ServerOptions = {}): { server: Server; runs: RunManager } {
  const runs = new RunManager({ dataDir: opts.dataDir ?? '.heal-server', timeoutMs: opts.timeoutMs, maxConcurrent: opts.maxConcurrent, maxPerUser: opts.maxPerUser, blockPrivateTargets: opts.blockPrivateTargets });
  const codeUploads = opts.allowCodeUploads !== false;
  /** Sign-ups per address in the last hour, so one visitor cannot fill the server with accounts. */
  const signups = new Map<string, number[]>();
  const SIGNUPS_PER_HOUR_ALL = 100;
  /** Uses of the AI helper per person in the last hour: each one costs the server owner money. */
  const aiUses = new Map<number, number[]>();
  const AI_PER_HOUR = Number(process.env.HEAL_AI_PER_HOUR) || 30;
  const aiAllowed = (userId: number) => {
    const recent = (aiUses.get(userId) ?? []).filter((t) => Date.now() - t < 3_600_000);
    if (recent.length >= AI_PER_HOUR) throw httpError(429, `You have used the AI helper ${AI_PER_HOUR} times in the last hour. Try again later, or use the standard generator.`);
    aiUses.set(userId, [...recent, Date.now()]);
  };
  /** Whether automatic mode may call the AI for this person now, without refusing the request when it may not. */
  const aiFree = (userId: number) => aiConfigured() && (aiUses.get(userId) ?? []).filter((t) => Date.now() - t < 3_600_000).length < AI_PER_HOUR;
  /** Writes test cases: 'auto' (the default) reads with the built-in reader and asks the AI only when that reading is poor. */
  const writeCases = async (text: string, userId: number, chosen: unknown, extra: { startPage?: string; testData?: Record<string, string> } = {}) => {
    const method = chosen === 'ai' || chosen === 'rules' ? chosen : 'auto';
    if (method === 'ai' && aiConfigured()) aiAllowed(userId);
    const out = await generate(text, { ...extra, method, allowAi: aiFree(userId) });
    if (method === 'auto' && out.by === 'ai') aiAllowed(userId);
    return out;
  };
  const generated = (out: Awaited<ReturnType<typeof generate>>) => ({ notes: out.notes, by: out.by, fallbackReason: out.fallbackReason, switched: out.switched, analysis: out.analysis });
  /** Starting a run: one person cannot fill the queue, and the address must be one this server may test. */
  const mayRun = async (owner: number | undefined, appUrl?: string) => {
    if (owner && runs.busyFor(owner) >= runs.maxPerUser) throw httpError(429, `You already have ${runs.maxPerUser} runs waiting or running. Wait for one to finish, or stop one.`);
    if (appUrl && opts.blockPrivateTargets) {
      const why = await blockedReason(appUrl);
      if (why) throw httpError(400, why);
    }
  };
  /** The visitor's address. Behind a proxy the connection is the proxy itself, so every visitor would otherwise share one sign-up and sign-in limit. */
  const clientIp = (req: IncomingMessage): string => {
    if (opts.trustProxy) {
      const real = String(req.headers['x-real-ip'] ?? '').trim();
      if (real) return real;
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (forwarded.length) return forwarded[forwarded.length - 1];
    }
    return req.socket.remoteAddress ?? '';
  };
  const noCode = () => httpError(403, 'Uploading test code is turned off on this server. Use a use case or test cases instead.');
  const maxUpload = opts.maxUploadBytes ?? 100 * 1024 * 1024;
  const auth = new Auth(runs.app.db);
  const suites = new SuiteStore(runs.app.db);
  const integrations = new Integrations(runs.app.db, opts.dataDir ?? '.heal-server', opts.integrationFetch);
  // When a re-test decides a filed bug's fate, say so on its ticket.
  runs.onReconciled = (run, bugs) => {
    for (const b of bugs) {
      if (!b.ticket || b.retest?.runId !== run.id) continue;
      const text = b.retest.result === 'passed'
        ? `EasyTesting re-tested this on ${new Date(b.retest.at).toUTCString()} (run ${run.id}): the test passed. Verified fixed.`
        : `EasyTesting re-tested this on ${new Date(b.retest.at).toUTCString()} (run ${run.id}): the test still fails, so the bug is reopened. ${b.error.split('\n')[0].slice(0, 300)}`;
      integrations.comment(b.ticket, text).catch((e) => console.error(`[integrations] could not comment on ${b.ticket!.key}: ${(e as Error).message}`));
    }
  };
  const suites_useCase = (owner: number, title: string, text: string) => suites.addUseCase(owner, title, text);
  /** Uploaded spreadsheets waiting for the tester to confirm which column is which. In memory, 30 minutes. */
  const imports = new Map<string, { owner: number; rows: string[][]; filename: string; at: number }>();
  /** Stands in for a person when accounts are off or the request carries the access token. */
  const SYSTEM: User = { id: 0, email: 'local', name: 'Local user', role: 'admin' };

  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'The request was not valid JSON.' });
      const status = e instanceof AuthError ? e.status : ((e as { status?: number }).status ?? 500);
      // An unexpected failure is logged for the owner; the visitor does not need file paths or internals.
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      json(res, status, { error: status === 500 ? 'Something went wrong on the server. Try again, and tell the admin if it keeps happening.' : (e as Error).message });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz') return json(res, 200, { ok: true });
    if (path.startsWith('/demo/')) {
      const page = demoPage(path, url.searchParams.get('v') ?? '1');
      if (!page) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(page);
    }
    if (!path.startsWith('/api/')) return serveStatic(res, path);

    const tokenOk = !!opts.token && (req.headers.authorization === `Bearer ${opts.token}` || url.searchParams.get('token') === opts.token);
    const ip = clientIp(req);
    let user: User | undefined;

    if (path === '/api/auth/state' && method === 'GET') {
      const me = opts.accounts ? auth.fromRequest(req) : SYSTEM;
      return json(res, 200, { accounts: !!opts.accounts, setup: !!opts.accounts && auth.userCount() === 0, user: me ?? null, codeUploads, signup: !!opts.accounts && !!opts.allowSignup });
    }
    if (opts.accounts) {
      // The cookie is SameSite=Strict; this also refuses any state-changing request (sign-in and sign-out included) that names another site as its origin.
      const origin = req.headers.origin;
      if (method !== 'GET' && method !== 'HEAD' && origin && originHost(origin) !== req.headers.host) throw httpError(403, 'Cross-site request refused.');
      if (path === '/api/auth/setup' && method === 'POST') {
        if (auth.userCount() > 0) throw httpError(403, 'Setup is already done. Sign in instead.');
        const b = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        auth.create({ email: b.email, name: b.name, password: b.password, role: 'admin' });
        return signIn(res, await auth.login(b.email, b.password, ip), !!opts.secureCookies);
      }
      if (path === '/api/auth/register' && method === 'POST') {
        if (!opts.allowSignup) throw httpError(403, 'Creating your own account is turned off here. Ask your admin to add you.');
        if (auth.userCount() === 0) throw httpError(409, 'Create the first (admin) account on the sign-in screen first.');
        for (const [k, v] of signups) if (!v.some((t) => Date.now() - t < 3_600_000)) signups.delete(k);
        const recent = (signups.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
        if (recent.length >= 5) throw httpError(429, 'Too many accounts were created from this address. Try again later.');
        if ([...signups.values()].reduce((n, v) => n + v.length, 0) >= SIGNUPS_PER_HOUR_ALL) throw httpError(429, 'Many accounts were created in the last hour. Try again later.');
        const b = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        auth.create({ email: b.email, name: b.name, password: b.password, role: 'tester' }); // always a tester, never an admin
        signups.set(ip, [...recent, Date.now()]);
        return signIn(res, await auth.login(b.email, b.password, ip), !!opts.secureCookies);
      }
      if (path === '/api/auth/login' && method === 'POST') {
        const b = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        return signIn(res, await auth.login(b.email, b.password, ip), !!opts.secureCookies);
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        auth.logout(cookie(req, COOKIE));
        res.setHeader('set-cookie', clearCookie);
        return json(res, 200, { ok: true });
      }
      const viaCookie = auth.fromRequest(req);
      user = viaCookie ?? (tokenOk ? { ...SYSTEM, name: 'Access token' } : undefined);
      if (!user) return json(res, 401, { error: 'Sign in to continue.', signIn: true });
    } else {
      if (opts.token && !tokenOk) return json(res, 401, { error: 'Missing or wrong token.' });
      user = SYSTEM;
    }
    const me = user;
    const isAdmin = me.role === 'admin';
    const mine = (r: { owner?: number }) => isAdmin || r.owner === me.id;
    const owner = me.id || undefined;

    if (path === '/api/users' || path.startsWith('/api/users/')) {
      if (!isAdmin) throw httpError(403, 'Only an admin can manage users.');
      if (path === '/api/users' && method === 'GET') return json(res, 200, auth.list());
      if (path === '/api/users' && method === 'POST') {
        const b = JSON.parse((await readBody(req, 10_000)).toString() || '{}');
        return json(res, 201, auth.create(b));
      }
      const um = path.match(/^\/api\/users\/(\d+)$/);
      if (um && method === 'PATCH') {
        auth.update(Number(um[1]), JSON.parse((await readBody(req, 10_000)).toString() || '{}'));
        return json(res, 200, { ok: true });
      }
    }


    // ---- use cases, test-case suites and the guided path ---------------------------------
    const json_ = async <T,>(limit = 1_000_000): Promise<T> => {
      try {
        return JSON.parse((await readBody(req, limit)).toString() || '{}') as T;
      } catch {
        throw httpError(400, 'The request was not valid JSON.');
      }
    };
    const suiteOf = (idText: string): Suite => {
      const sv = suites.get(Number(idText));
      if (!sv || !mine(sv)) throw httpError(404, 'No such test-case set.');
      return sv;
    };

    if (path === '/api/ai' && method === 'GET') return json(res, 200, { available: aiConfigured(), model: AI_MODEL });
    if (path === '/api/example' && method === 'GET') return json(res, 200, { useCase: DEMO_USE_CASE, testData: DEMO_TEST_DATA });

    if (path === '/api/steps/interpret' && method === 'POST') {
      const b = await json_<{ steps?: string[] }>(200_000);
      return json(res, 200, { steps: (b.steps ?? []).slice(0, 300).map(interpret) });
    }
    if (path === '/api/steps/improve' && method === 'POST') {
      const b = await json_<{ steps?: string[] }>(200_000);
      const client = await defaultClient();
      if (!client) throw httpError(409, 'The AI helper is not set up on this server (no ANTHROPIC_API_KEY).');
      aiAllowed(me.id);
      try {
        const better = await improveSteps((b.steps ?? []).map(String), client);
        return json(res, 200, { steps: better.map(interpret) });
      } catch (e) {
        throw httpError(502, e instanceof AiError ? e.message : (e as Error).message);
      }
    }

    if (path === '/api/usecases/read' && method === 'POST') {
      // A use case sent as a file: text and Markdown as they are; a spreadsheet becomes one line per row.
      const filename = url.searchParams.get('filename') ?? 'usecase.txt';
      const data = await readBody(req, 10_000_000);
      if (/\.(xlsx|csv)$/i.test(filename)) {
        try {
          return json(res, 200, { text: readSheet(new Uint8Array(data), filename).map((r) => r.filter(Boolean).join(' - ')).join('\n') });
        } catch (e) {
          throw httpError(400, (e as Error).message);
        }
      }
      if (/\.(docx?|pdf)$/i.test(filename)) throw httpError(400, 'Word and PDF files cannot be read here yet. Copy the text and paste it into the box.');
      return json(res, 200, { text: decodeText(new Uint8Array(data)) });
    }

    if (path === '/api/usecases/generate' && method === 'POST') {
      const b = await json_<{ title?: string; text?: string; method?: 'rules' | 'ai' | 'auto'; startPage?: string; testData?: unknown; appUrl?: string }>(300_000);
      const text = String(b.text ?? '').trim();
      if (text.length < 20) throw httpError(400, 'Paste or upload a use case first. It needs at least a few sentences.');
      if (text.length > 60_000) throw httpError(413, 'That use case is too long. Split it into several use cases.');
      const out = await writeCases(text, me.id, b.method, { startPage: b.startPage?.trim() || undefined, testData: parseTestData(b.testData) });
      const title = (b.title?.trim() || out.useCase.title || 'Generated test cases').slice(0, 120);
      const sv = suites.create(me.id, { title, source: 'generated', usecaseId: suites_useCase(me.id, title, text), appUrl: String(b.appUrl ?? '').trim(), cases: out.cases });
      return json(res, 201, { suite: suiteView(sv), ...generated(out) });
    }

    if (path === '/api/suites' && method === 'GET') return json(res, 200, suites.list(isAdmin ? undefined : me.id).map((x) => ({ id: x.id, title: x.title, source: x.source, cases: x.cases.length, appUrl: x.appUrl, updatedAt: x.updatedAt })));
    const sm = path.match(/^\/api\/suites\/(\d+)(?:\/(\w+))?$/);
    if (sm) {
      const sv = suiteOf(sm[1]);
      const action = sm[2];
      if (!action && method === 'GET') return json(res, 200, suiteView(sv));
      if (!action && method === 'PUT') {
        const b = await json_<{ title?: string; appUrl?: string; cases?: unknown }>(2_000_000);
        const updated = suites.update(sv.id, { title: b.title, appUrl: b.appUrl, cases: b.cases === undefined ? undefined : cleanCases(b.cases) });
        return json(res, 200, suiteView(updated!));
      }
      if (!action && method === 'DELETE') return json(res, 200, { deleted: suites.delete(sv.id) });
      if (action === 'regenerate' && method === 'POST') {
        // Writes the cases again from the same use case, with the current generator. Edits made since are replaced.
        const uc = sv.usecaseId ? suites.getUseCase(sv.usecaseId) : undefined;
        if (!uc) throw httpError(409, 'This set was uploaded, not generated from a use case, so it cannot be rebuilt. Use "Fix the gaps" instead.');
        const b = await json_<{ method?: 'rules' | 'ai' | 'auto' }>(10_000);
        const out = await writeCases(uc.body, me.id, b.method);
        const updated = suites.update(sv.id, { cases: out.cases });
        return json(res, 200, { suite: suiteView(updated!), ...generated(out) });
      }
      if (action === 'download' && method === 'GET') {
        const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'xlsx';
        const rows = casesToRows(sv.cases);
        const name = sv.title.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'test-cases';
        if (format === 'csv') {
          res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"` });
          return res.end(writeCsv(rows));
        }
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}.xlsx"` });
        return res.end(Buffer.from(writeXlsx(rows, 'Test cases', COLUMN_WIDTHS)));
      }
      if (action === 'run' && method === 'POST') {
        const b = await json_<{ appUrl?: string; stopOnFail?: boolean }>(10_000);
        const appUrl = String(b.appUrl ?? sv.appUrl).trim();
        if (!/^https?:\/\/\S+$/i.test(appUrl)) throw httpError(400, 'Enter the app link, starting with http:// or https://');
        const runnable = sv.cases.filter((c) => c.steps.length);
        if (!runnable.length) throw httpError(400, 'None of these test cases has any steps to run.');
        await mayRun(owner, appUrl);
        if (appUrl !== sv.appUrl) suites.update(sv.id, { appUrl });
        return json(res, 202, runs.createCases({ title: sv.title, appUrl, cases: sv.cases, owner, suite: sv.id, stopOnFail: !!b.stopOnFail }));
      }
    }

    if (path === '/api/imports' && method === 'POST') {
      const filename = url.searchParams.get('filename') ?? 'cases.csv';
      const data = await readBody(req, maxUpload);
      if (!data.length) throw httpError(400, 'The file is empty.');
      let rows: string[][];
      try {
        rows = readSheet(new Uint8Array(data), filename);
      } catch (e) {
        throw httpError(400, (e as Error).message);
      }
      if (rows.length < 1) throw httpError(400, 'No rows were found in that file.');
      for (const [k, v] of imports) if (Date.now() - v.at > 30 * 60_000) imports.delete(k);
      if (imports.size >= 50) throw httpError(429, 'Too many uploads waiting. Finish or wait a few minutes.');
      const id = randomBytes(8).toString('hex');
      imports.set(id, { owner: me.id, rows, filename, at: Date.now() });
      const hasHeader = hasHeaderRow(rows);
      const header = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
      return json(res, 201, { importId: id, filename, rowCount: rows.length - (hasHeader ? 1 : 0), hasHeader, header, mapping: detectMapping(hasHeader ? rows[0] : []), preview: rows.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 6), fields: FIELDS });
    }
    const im = path.match(/^\/api\/imports\/([a-f0-9]{16})\/confirm$/);
    if (im && method === 'POST') {
      const up = imports.get(im[1]);
      if (!up || up.owner !== me.id) throw httpError(404, 'That upload expired. Upload the file again.');
      const b = await json_<{ mapping?: Mapping; hasHeader?: boolean; title?: string; appUrl?: string }>(50_000);
      const mapping = Object.fromEntries(FIELDS.map((f) => [f, Number.isInteger(b.mapping?.[f]) ? b.mapping![f] : -1])) as Mapping;
      if (mapping.steps < 0) throw httpError(400, 'Choose which column holds the steps.');
      const { cases, warnings } = rowsToCases(up.rows, mapping, b.hasHeader !== false);
      if (!cases.length) throw httpError(400, 'No test cases were found with those columns.');
      if (cases.length > 500) throw httpError(413, 'More than 500 test cases in one file. Split it.');
      const title = (b.title?.trim() || up.filename.replace(/\.[^.]+$/, '') || 'Uploaded test cases').slice(0, 120);
      const sv = suites.create(me.id, { title, source: 'uploaded', appUrl: String(b.appUrl ?? '').trim(), cases: cleanCases(cases) });
      imports.delete(im[1]);
      return json(res, 201, { suite: suiteView(sv), warnings });
    }

    if (path === '/api/runs' && method === 'GET') return json(res, 200, runs.list().filter(mine).slice(0, 200).map((r) => ({ ...r, ...runs.summary(r.id) })));

    if (path === '/api/demo' && method === 'POST') {
      const v = ['2', '3'].includes(url.searchParams.get('version') ?? '') ? url.searchParams.get('version')! : '1';
      const origin = `http://127.0.0.1:${req.socket.localPort}`;
      await mayRun(owner);
      return json(res, 202, await runs.createDemo(`${origin}/demo/app?v=${v}`, v, owner));
    }

    if (path === '/api/runs' && method === 'POST') {
      if (!codeUploads) throw noCode();
      await mayRun(owner);
      const framework = (url.searchParams.get('framework') ?? 'playwright') as Framework;
      if (!FRAMEWORKS.includes(framework)) throw httpError(400, `framework must be one of ${FRAMEWORKS.join(', ')}`);
      const filename = url.searchParams.get('filename') ?? 'tests.zip';
      const upload = await readBody(req, maxUpload);
      if (!upload.length) throw httpError(400, 'Upload the test project as the request body (a .zip, or a single test file).');
      const run = runs.create({
        name: url.searchParams.get('name') ?? '',
        framework,
        appUrl: url.searchParams.get('appUrl') ?? '',
        command: url.searchParams.get('command') ?? undefined,
        install: url.searchParams.get('install') !== '0',
        upload,
        filename,
        owner,
      });
      return json(res, 202, run);
    }

    const m = path.match(/^\/api\/runs\/([a-f0-9]{12})(?:\/([\w.]+))?(?:\/([\w.-]+))?$/);
    if (m) {
      const [, id, action, sub] = m;
      const run = runs.get(id);
      if (!run || !mine(run)) throw httpError(404, 'No such run.');
      if (!action && method === 'GET') return json(res, 200, { ...run, ...runs.summary(id), heals: runs.heals(id).map(slim) });
      if (!action && method === 'DELETE') return json(res, 200, { deleted: runs.delete(id) });
      if (action === 'log' && method === 'GET') {
        const f = runs.logFile(id);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return existsSync(f) ? res.end(readFileSync(f)) : res.end('');
      }
      if (action === 'steps' && method === 'GET') return json(res, 200, runs.steps(id) ?? { cases: [] });
      if (action === 'shots' && sub && method === 'GET') {
        const file = runs.screenshot(id, /\.(?:png|jpg)$/.test(sub) ? sub : sub + '.png');
        if (!file) throw httpError(404, 'No such screenshot.');
        res.writeHead(200, { 'content-type': file.endsWith('.jpg') ? 'image/jpeg' : 'image/png', 'cache-control': 'private, max-age=3600' });
        return res.end(readFileSync(file));
      }
      if (action === 'report' && method === 'GET') return json(res, 200, runs.report(id));
      if (action === 'screenshots.zip' && method === 'GET') {
        if (ACTIVE_STATUS.includes(run.status)) throw httpError(409, 'The run is still going. The pictures can be downloaded when it has finished.');
        const out = runs.screenshotsZip(id);
        if (!out) throw httpError(404, 'This run has no step pictures. They are kept for runs of test cases written in the app.');
        const name = out.folder.replace(/[^\w .-]+/g, '_');
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"; filename*=UTF-8''${encodeURIComponent(out.folder)}.zip`, 'x-pictures': String(out.pictures) });
        return res.end(Buffer.from(out.zip));
      }
      if (action === 'rerun' && method === 'POST') {
        if (!codeUploads && !run.kind && !run.demo) throw noCode();
        await mayRun(owner, run.kind === 'cases' ? run.appUrl : undefined);
        return json(res, 202, await runs.rerun(id));
      }
      if (action === 'scenarios' && method === 'GET') return json(res, 200, runs.scenarios(run.project));
      if (action === 'scenarios' && (method === 'PUT' || method === 'POST')) {
        const csv = (await readBody(req, 2_000_000)).toString();
        const scenarios = runs.setScenarios(id, csv);
        if (!scenarios.length) throw httpError(400, 'No scenarios found. Use a CSV with a header row such as: id,title,area,priority');
        return json(res, 200, { scenarios });
      }
      if (action === 'tickets' && !sub && method === 'POST') {
        // File one of this run's bugs in Jira or Azure DevOps, linked to a user story when one is chosen.
        const b = await json_<{ bugId?: string; tool?: Tool; storyKey?: string }>(10_000);
        if (b.tool !== 'jira' && b.tool !== 'ado') throw httpError(400, 'Choose Jira or Azure DevOps.');
        const tracker = runs.tracker(run.project);
        const bug = tracker.list().find((x) => x.id === b.bugId);
        if (!bug) throw httpError(404, 'No such bug.');
        if (bug.ticket) throw httpError(409, `This bug is already filed as ${bug.ticket.key}.`);
        try {
          let story;
          if (b.storyKey) {
            story = (await integrations.stories(b.tool, String(b.storyKey))).find((x) => x.key.toLowerCase() === String(b.storyKey).toLowerCase());
            if (!story) throw httpError(400, `User story ${b.storyKey} was not found.`);
          }
          const proto = String(req.headers['x-forwarded-proto'] ?? (opts.secureCookies ? 'https' : 'http')).split(',')[0];
          const ticket = await integrations.createTicket(b.tool, bug, { story, appUrl: run.appUrl || undefined, reportUrl: req.headers.host ? `${proto}://${req.headers.host}/#/report/${run.id}` : undefined });
          return json(res, 201, tracker.setTicket(bug.id, ticket, me.name || me.email));
        } catch (e) {
          if (e instanceof IntegrationError) throw httpError(e.status, e.message);
          throw e;
        }
      }
      if (action === 'tickets' && sub === 'refresh' && method === 'POST') {
        // Reads the current status of this project's tickets; each is read at most once a minute.
        const tracker = runs.tracker(run.project);
        const due = tracker.list().filter((x) => x.ticket && (!x.ticket.status || Date.now() - Date.parse(x.ticket.status.at) > 60_000)).slice(0, 25);
        const errors: string[] = [];
        for (const x of due) {
          try {
            tracker.setTicketStatus(x.id, await integrations.status(x.ticket!));
          } catch (e) {
            errors.push(`${x.ticket!.key}: ${(e as Error).message}`);
          }
        }
        return json(res, 200, { checked: due.length, errors: errors.slice(0, 3) });
      }
      if (action === 'bugs' && sub && method === 'PATCH') {
        const body = JSON.parse((await readBody(req, 100_000)).toString() || '{}');
        const bug = runs.updateBug(id, sub, { status: body.status, severity: body.severity, note: body.note });
        if (!bug) throw httpError(404, 'No such bug.');
        return json(res, 200, bug);
      }
      if (action === 'bugs.csv' && method === 'GET') {
        const report = runs.report(id)!;
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${id}-bugs.csv"` });
        return res.end(bugsCsv(report.bugs));
      }
      if (action === 'stop' && method === 'POST') return json(res, 200, { stopped: runs.stop(id) });
      if (action === 'apply' && method === 'POST') {
        const body = JSON.parse((await readBody(req, 1_000_000)).toString() || '{}') as { approve?: string[]; only?: string[] };
        const done = runs.apply(id, Array.isArray(body.approve) ? body.approve : [], Array.isArray(body.only) ? body.only : undefined);
        return json(res, 200, { applied: done.map(slim) });
      }
      if (action === 'download' && method === 'GET') {
        const zip = runs.zip(id);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${id}-healed.zip"` });
        return res.end(zip);
      }
    }
    // ---- Jira and Azure DevOps ------------------------------------------------------
    const ig = path.match(/^\/api\/integrations(?:\/(jira|ado))?(?:\/(test|stories))?$/);
    if (ig) {
      const tool = ig[1] as Tool | undefined;
      const wrap = async <T,>(fn: () => Promise<T>) => {
        try {
          return await fn();
        } catch (e) {
          if (e instanceof IntegrationError) throw httpError(e.status, e.message);
          throw e;
        }
      };
      if (!tool && method === 'GET') return json(res, 200, integrations.summary());
      if (tool && ig[2] === 'stories' && method === 'GET') return json(res, 200, await wrap(() => integrations.stories(tool, url.searchParams.get('q') ?? '')));
      if (tool && !isAdmin) throw httpError(403, 'Only an admin can change the Jira and Azure DevOps connections.');
      if (tool && ig[2] === 'test' && method === 'POST') {
        const b = await json_<Record<string, unknown>>(20_000);
        return json(res, 200, { message: await wrap(async () => { const { config, token } = integrations.clean(tool, b); return integrations.test(tool, config, token); }) });
      }
      if (tool && !ig[2] && method === 'PUT') {
        // Saved only once it works, so a mistyped token never replaces a good one.
        const b = await json_<Record<string, unknown>>(20_000);
        const message = await wrap(async () => {
          const { config, token } = integrations.clean(tool, b);
          const said = await integrations.test(tool, config, token);
          integrations.save(tool, config, token);
          return said;
        });
        return json(res, 200, { message, summary: integrations.summary() });
      }
      if (tool && !ig[2] && method === 'DELETE') return json(res, 200, { removed: integrations.remove(tool), summary: integrations.summary() });
    }

    throw httpError(404, 'Not found.');
  }

  return { server, runs };
}


/** How the step reader understood a step, in a form the screen can show. */
function interpret(text: string) {
  const p = parseStep(String(text));
  return { text: String(text), action: p.action, target: p.target, hint: p.hint, value: p.value, check: p.check, confidence: p.confidence, notes: p.notes, needsValue: !!p.needsValue, summary: describeStep(p) };
}

function suiteView(sv: Suite) {
  return { ...sv, cases: sv.cases.map((c) => ({ ...c, interpreted: c.steps.map(interpret) })) };
}

/** Keeps only the fields of a test case, with sizes limited, from whatever the client sent. */
function cleanCases(input: unknown): TestCase[] {
  if (!Array.isArray(input)) throw httpError(400, 'cases must be a list.');
  const str = (v: unknown, n = 1000) => String(v ?? '').trim().slice(0, n);
  const seen = new Set<string>();
  return input.slice(0, 500).map((c: Record<string, unknown>, i) => {
    let id = str(c.id, 40) || `TC-${String(i + 1).padStart(3, '0')}`;
    while (seen.has(id.toLowerCase())) id += '-2';
    seen.add(id.toLowerCase());
    return {
      id, title: str(c.title, 200) || id, area: str(c.area, 100) || undefined, priority: str(c.priority, 30) || undefined, type: str(c.type, 30) || undefined,
      preconditions: str(c.preconditions, 1000) || undefined, steps: (Array.isArray(c.steps) ? c.steps : []).slice(0, 100).map((x) => str(x)).filter(Boolean),
      expected: str(c.expected, 1000), source: str(c.source, 200) || undefined, basis: c.basis === 'assumed' ? ('assumed' as const) : c.basis === 'stated' ? ('stated' as const) : undefined,
    };
  });
}

/** "email=a@b.co" lines or an object, as a lower-case map. */
function parseTestData(v: unknown): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (typeof v === 'string') {
    for (const line of v.split(/\r?\n/)) {
      const m = line.match(/^\s*([^=:]+?)\s*[=:]\s*(.+?)\s*$/);
      if (m) out[m[1].toLowerCase()] = m[2];
    }
  } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) out[k.toLowerCase()] = String(x);
  return Object.keys(out).length ? out : undefined;
}

const csvCell = (v: unknown) => {
  const t = String(v ?? '');
  // Spreadsheets run text that starts with = + - @ as a formula; keep it as text.
  const safe = /^[=+\-@]/.test(t) ? "'" + t : t;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

function bugsCsv(bugs: import('./bugs.js').Bug[]): string {
  const head = ['id', 'title', 'test', 'severity', 'status', 'cause', 'first run', 'last run', 'times seen', 're-test result', 'ticket', 'ticket status', 'ticket link', 'user story', 'error'];
  const rows = bugs.map((b) => [b.id, b.title, b.test, b.severity, b.status, b.cause, b.firstRun, b.lastRun, b.occurrences, b.retest?.result ?? '', b.ticket?.key ?? '', b.ticket?.status?.name ?? '', b.ticket?.url ?? '', b.ticket?.story ? `${b.ticket.story.key} ${b.ticket.story.title}` : '', b.error]);
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A heal record without the bulky element dumps, for the UI. */
function slim(r: import('../core.js').HealRecord) {
  const { oldNode, matched, decision, fingerprintAfter, ...rest } = r;
  return {
    ...rest,
    file: r.file ? r.file.split(/[\\/]project[\\/]/).pop() : undefined,
    before: describeNode(oldNode),
    after: matched ? describeNode(matched) : undefined,
    candidates: decision.top.map((t) => ({ score: t.score, node: describeNode(t.node) })),
  };
}

const describeNode = (n: import('../model.js').UINode) => `<${n.tag}> ${n.role !== 'generic' ? `role=${n.role} ` : ''}"${n.name || n.text}"${n.attrs.id ? ` #${n.attrs.id}` : ''}`;

function signIn(res: ServerResponse, s: { user: User; token: string }, secure: boolean) {
  res.setHeader('set-cookie', sessionCookie(s.token, secure));
  return json(res, 200, { user: s.user });
}

/** The host of an Origin header, or undefined when it is not an address (a page opened from a file sends "null"). */
function originHost(origin: string): string | undefined {
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, `Upload is larger than ${Math.round(limit / 1024 / 1024)} MB.`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res: ServerResponse, path: string) {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/cases.js': ['cases.js', 'text/javascript; charset=utf-8'],
  };
  const hit = files[path];
  if (!hit) return json(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-cache' });
  createReadStream(join(HERE, 'public', hit[0])).pipe(res);
}

export function serve(opts: ServerOptions = {}): Promise<Server> {
  const { server } = createApp(opts);
  const port = opts.port ?? 4173;
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
