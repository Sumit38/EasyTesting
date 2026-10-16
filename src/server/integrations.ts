import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from '../db.js';
import type { Bug, Ticket, TicketStatus } from './bugs.js';

/**
 * Connections to Jira Cloud and Azure DevOps Services, set up once by an admin and used by everyone to file EasyTesting
 * bugs as tickets, link them to user stories, follow their status and report re-test results back.
 */
export type Tool = 'jira' | 'ado';

export interface JiraConfig {
  /** https://yourcompany.atlassian.net */
  site: string;
  email: string;
  project: string;
  bugType: string;
  storyType: string;
}
export interface AdoConfig {
  /** https://dev.azure.com/yourorg */
  org: string;
  project: string;
  bugType: string;
  storyType: string;
}
type Config = { jira: JiraConfig; ado: AdoConfig };

export interface Story {
  key: string;
  title: string;
  status: string;
  url: string;
}

export class IntegrationError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const TIMEOUT = 15_000;

export class Integrations {
  private readonly key: Buffer;

  /** `send` is fetch; tests pass a stand-in for Jira and Azure DevOps. */
  constructor(private readonly db: DatabaseSync, dataDir: string, private readonly send: typeof fetch = fetch) {
    db.exec('CREATE TABLE IF NOT EXISTS integrations (tool TEXT PRIMARY KEY, config TEXT NOT NULL, secret TEXT NOT NULL, updated_at TEXT NOT NULL)');
    // The key that encrypts the API tokens lives next to the database, on the same private disk, never in the database itself.
    const file = join(dataDir, 'secret.key');
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  }

  private encrypt(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }
  private decrypt(stored: string): string {
    const [iv, tag, body] = stored.split('.').map((x) => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  }

  private row<T extends Tool>(tool: T): { config: Config[T]; token: string } | undefined {
    const r = this.db.prepare('SELECT config, secret FROM integrations WHERE tool = ?').get(tool) as { config: string; secret: string } | undefined;
    if (!r) return undefined;
    try {
      return { config: JSON.parse(r.config), token: this.decrypt(r.secret) };
    } catch {
      return undefined; // the key file was replaced: the admin has to enter the token again
    }
  }

  /** What the screens may know: which tools are connected and to what. Never the token. */
  summary(): Record<Tool, { connected: boolean; project?: string; where?: string; bugType?: string; storyType?: string }> {
    const j = this.row('jira'), a = this.row('ado');
    return {
      jira: j ? { connected: true, project: j.config.project, where: j.config.site, bugType: j.config.bugType, storyType: j.config.storyType } : { connected: false },
      ado: a ? { connected: true, project: a.config.project, where: a.config.org, bugType: a.config.bugType, storyType: a.config.storyType } : { connected: false },
    };
  }

  /** The admin's settings for one tool, checked and cleaned. A blank token keeps the one already saved. */
  clean(tool: Tool, input: Record<string, unknown>): { config: JiraConfig | AdoConfig; token: string } {
    const s = (k: string, n = 200) => String(input[k] ?? '').trim().slice(0, n);
    const token = s('token', 2000) || this.row(tool)?.token || '';
    if (!token) throw new IntegrationError(tool === 'jira' ? 'Enter the Jira API token.' : 'Enter the Azure DevOps personal access token.', 400);
    if (tool === 'jira') {
      const site = s('site').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(site)) throw new IntegrationError('The Jira address looks like https://yourcompany.atlassian.net', 400);
      if (!/^[^@\s]+@[^@\s]+$/.test(s('email'))) throw new IntegrationError('Enter the email address of the Jira account that owns the API token.', 400);
      if (!/^[A-Z][A-Z0-9_]{0,19}$/i.test(s('project'))) throw new IntegrationError('Enter the Jira project key, for example SHOP (the letters before the number in SHOP-123).', 400);
      return { config: { site, email: s('email'), project: s('project').toUpperCase(), bugType: s('bugType', 60) || 'Bug', storyType: s('storyType', 60) || 'Story' }, token };
    }
    const org = s('org').replace(/\/+$/, '');
    if (!/^https:\/\/(?:dev\.azure\.com\/[\w.-]+|[\w-]+\.visualstudio\.com)$/i.test(org)) throw new IntegrationError('The Azure DevOps address looks like https://dev.azure.com/yourorg', 400);
    if (!s('project')) throw new IntegrationError('Enter the Azure DevOps project name.', 400);
    return { config: { org, project: s('project'), bugType: s('bugType', 60) || 'Bug', storyType: s('storyType', 60) || 'User Story' }, token };
  }

  save(tool: Tool, config: JiraConfig | AdoConfig, token: string): void {
    this.db.prepare('INSERT INTO integrations (tool, config, secret, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(tool) DO UPDATE SET config = excluded.config, secret = excluded.secret, updated_at = excluded.updated_at')
      .run(tool, JSON.stringify(config), this.encrypt(token), new Date().toISOString());
  }

  remove(tool: Tool): boolean {
    return this.db.prepare('DELETE FROM integrations WHERE tool = ?').run(tool).changes > 0;
  }

  /** Signs in and finds the project, so the admin knows at once whether the settings work. */
  async test(tool: Tool, config: JiraConfig | AdoConfig, token: string): Promise<string> {
    if (tool === 'jira') {
      const c = config as JiraConfig;
      const me = await jira<{ displayName: string }>(this.send, c, token, 'GET', '/rest/api/3/myself');
      const p = await jira<{ name: string; issueTypes?: { name: string }[] }>(this.send, c, token, 'GET', `/rest/api/3/project/${encodeURIComponent(c.project)}`);
      const types = (p.issueTypes ?? []).map((t) => t.name);
      const missing = [c.bugType, c.storyType].filter((t) => types.length && !types.includes(t));
      if (missing.length) throw new IntegrationError(`Signed in as ${me.displayName}, but project ${c.project} has no issue type called ${missing.map((m) => `"${m}"`).join(' or ')}. Its types are: ${types.join(', ')}.`, 400);
      return `Connected as ${me.displayName} to project ${p.name} (${c.project}).`;
    }
    const c = config as AdoConfig;
    const p = await ado<{ name: string }>(this.send, c, token, 'GET', `/_apis/projects/${encodeURIComponent(c.project)}?api-version=7.1`, undefined, false);
    const types = await ado<{ value: { name: string }[] }>(this.send, c, token, 'GET', '/_apis/wit/workitemtypes?api-version=7.1');
    const names = types.value.map((t) => t.name);
    const missing = [c.bugType, c.storyType].filter((t) => !names.includes(t));
    if (missing.length) throw new IntegrationError(`Found project ${p.name}, but it has no work item type called ${missing.map((m) => `"${m}"`).join(' or ')}. Its types are: ${names.join(', ')}.`, 400);
    return `Connected to project ${p.name} in ${c.org.replace(/^https:\/\//, '')}.`;
  }

  private need<T extends Tool>(tool: T) {
    const r = this.row(tool);
    if (!r) throw new IntegrationError(`${tool === 'jira' ? 'Jira' : 'Azure DevOps'} is not connected. An admin can connect it under Team.`, 409);
    return r;
  }

  /** User stories to link a bug to: the newest first, or those matching the words or the key typed. */
  async stories(tool: Tool, query: string): Promise<Story[]> {
    const q = query.replace(/["'\\]/g, ' ').trim().slice(0, 80);
    if (tool === 'jira') {
      const { config: c, token } = this.need('jira');
      const byKey = /^[A-Z][A-Z0-9_]*-\d+$/i.test(q);
      const jql = `project = "${c.project}" AND issuetype = "${c.storyType}"${q ? (byKey ? ` AND key = "${q.toUpperCase()}"` : ` AND summary ~ "${q}*"`) : ''} ORDER BY updated DESC`;
      const out = await jira<{ issues: { key: string; fields: { summary: string; status: { name: string } } }[] }>(this.send, c, token, 'POST', '/rest/api/3/search/jql', { jql, maxResults: 20, fields: ['summary', 'status'] });
      return out.issues.map((i) => ({ key: i.key, title: i.fields.summary, status: i.fields.status?.name ?? '', url: `${c.site}/browse/${i.key}` }));
    }
    const { config: c, token } = this.need('ado');
    const id = /^\d+$/.test(q) ? Number(q) : undefined;
    const where = id ? `[System.Id] = ${id}` : q ? `[System.Title] CONTAINS '${q}'` : '';
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = '${c.storyType.replace(/'/g, '')}'${where ? ` AND ${where}` : ''} ORDER BY [System.ChangedDate] DESC`;
    const found = await ado<{ workItems: { id: number }[] }>(this.send, c, token, 'POST', '/_apis/wit/wiql?$top=20&api-version=7.1', { query: wiql });
    const ids = found.workItems.slice(0, 20).map((w) => w.id);
    if (!ids.length) return [];
    const items = await ado<{ value: { id: number; fields: Record<string, string> }[] }>(this.send, c, token, 'GET', `/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Title,System.State&api-version=7.1`, undefined, false);
    return items.value.map((w) => ({ key: String(w.id), title: w.fields['System.Title'], status: w.fields['System.State'], url: adoItemUrl(c, w.id) }));
  }

  /** Files the bug, linked to the story when one is given. */
  async createTicket(tool: Tool, bug: Bug, ctx: { reportUrl?: string; appUrl?: string; story?: Story }): Promise<Ticket> {
    const lines = describe(bug, ctx);
    const title = `[EasyTesting] ${bug.title}`.slice(0, 250);
    const now = new Date().toISOString();
    if (tool === 'jira') {
      const { config: c, token } = this.need('jira');
      const made = await jira<{ key: string }>(this.send, c, token, 'POST', '/rest/api/3/issue', {
        fields: { project: { key: c.project }, issuetype: { name: c.bugType }, summary: title, labels: ['easytesting'], description: adf(lines) },
      });
      if (ctx.story) {
        await jira(this.send, c, token, 'POST', '/rest/api/3/issueLink', { type: { name: 'Relates' }, inwardIssue: { key: made.key }, outwardIssue: { key: ctx.story.key } }).catch((e) => {
          throw new IntegrationError(`Created ${made.key}, but could not link it to ${ctx.story!.key}: ${(e as Error).message}`);
        });
      }
      const ticket: Ticket = { tool, key: made.key, url: `${c.site}/browse/${made.key}`, story: ctx.story, createdAt: now };
      // Projects start bugs in different states ("To Do", "Open", "Backlog"): read the real one rather than guess.
      ticket.status = await this.status(ticket).catch(() => undefined);
      return ticket;
    }
    const { config: c, token } = this.need('ado');
    const html = lines.map((l) => (l.code ? `<pre>${esc(l.text)}</pre>` : `<div>${l.bold ? `<b>${esc(l.bold)}</b> ` : ''}${esc(l.text)}</div>`)).join('');
    const ops: unknown[] = [
      { op: 'add', path: '/fields/System.Title', value: title },
      { op: 'add', path: c.bugType === 'Bug' ? '/fields/Microsoft.VSTS.TCM.ReproSteps' : '/fields/System.Description', value: html },
      { op: 'add', path: '/fields/System.Tags', value: 'EasyTesting' },
    ];
    // The bug becomes a child of the user story, so it shows under the story on the board.
    if (ctx.story) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${c.org}/_apis/wit/workItems/${ctx.story.key}` } });
    const made = await ado<{ id: number; fields: Record<string, string> }>(this.send, c, token, 'POST', `/_apis/wit/workitems/$${encodeURIComponent(c.bugType)}?api-version=7.1`, ops, true, 'application/json-patch+json');
    return { tool, key: String(made.id), url: adoItemUrl(c, made.id), story: ctx.story, createdAt: now, status: { name: made.fields?.['System.State'] ?? 'New', category: 'todo', at: now } };
  }

  /** The ticket's status as it is now in Jira or Azure DevOps. */
  async status(ticket: Ticket): Promise<TicketStatus> {
    const at = new Date().toISOString();
    if (ticket.tool === 'jira') {
      const { config: c, token } = this.need('jira');
      const i = await jira<{ fields: { status: { name: string; statusCategory?: { key: string } } } }>(this.send, c, token, 'GET', `/rest/api/3/issue/${encodeURIComponent(ticket.key)}?fields=status`);
      const cat = i.fields.status.statusCategory?.key;
      return { name: i.fields.status.name, category: cat === 'done' ? 'done' : cat === 'indeterminate' ? 'doing' : 'todo', at };
    }
    const { config: c, token } = this.need('ado');
    const w = await ado<{ fields: Record<string, string> }>(this.send, c, token, 'GET', `/_apis/wit/workitems/${encodeURIComponent(ticket.key)}?fields=System.State&api-version=7.1`, undefined, false);
    const state = w.fields['System.State'] ?? '';
    return { name: state, category: /^(closed|done|resolved|removed)$/i.test(state) ? 'done' : /^(new|to do|proposed|approved)$/i.test(state) ? 'todo' : 'doing', at };
  }

  /** Adds a comment to the ticket, for example the result of a re-test. */
  async comment(ticket: Ticket, text: string): Promise<void> {
    if (ticket.tool === 'jira') {
      const { config: c, token } = this.need('jira');
      await jira(this.send, c, token, 'POST', `/rest/api/3/issue/${encodeURIComponent(ticket.key)}/comment`, { body: adf([{ text }]) });
      return;
    }
    const { config: c, token } = this.need('ado');
    await ado(this.send, c, token, 'POST', `/_apis/wit/workItems/${encodeURIComponent(ticket.key)}/comments?api-version=7.1-preview.4`, { text: esc(text) });
  }
}

type Line = { text: string; bold?: string; code?: boolean };

/** What a developer needs to look at the bug, in the order they need it. */
function describe(bug: Bug, ctx: { reportUrl?: string; appUrl?: string; story?: Story }): Line[] {
  const cause = { assertion: 'A check failed (wrong result)', 'element-not-found': 'An element was not found', timeout: 'Timed out', error: 'Error' }[bug.cause];
  return [
    { bold: 'Found by EasyTesting:', text: `test "${bug.test}" failed.` },
    { bold: 'Severity:', text: bug.severity },
    { bold: 'Cause:', text: cause },
    ...(ctx.appUrl ? [{ bold: 'App tested:', text: ctx.appUrl }] : []),
    { bold: 'Seen in:', text: `${bug.occurrences} run${bug.occurrences === 1 ? '' : 's'} (first ${bug.firstRun}, last ${bug.lastRun})` },
    ...(ctx.story ? [{ bold: 'User story:', text: `${ctx.story.key} ${ctx.story.title}` }] : []),
    { bold: 'What happened:', text: '' },
    { text: bug.error.slice(0, 3000), code: true },
    ...(ctx.reportUrl ? [{ bold: 'Full report, steps and screenshots:', text: ctx.reportUrl }] : []),
    { text: 'When this is fixed, EasyTesting re-tests it and adds the result here as a comment.' },
  ];
}

/** Jira's document format, from plain lines. */
function adf(lines: Line[]) {
  return {
    type: 'doc', version: 1,
    content: lines.map((l) => (l.code
      ? { type: 'codeBlock', content: l.text ? [{ type: 'text', text: l.text }] : [] }
      : { type: 'paragraph', content: [...(l.bold ? [{ type: 'text', text: l.bold + ' ', marks: [{ type: 'strong' }] }] : []), ...(l.text ? [{ type: 'text', text: l.text }] : [])] })),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const adoItemUrl = (c: AdoConfig, id: number | string) => `${c.org}/${encodeURIComponent(c.project)}/_workitems/edit/${id}`;

async function call<T>(send: typeof fetch, url: string, init: RequestInit, name: string): Promise<T> {
  let res: Response;
  try {
    res = await send(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new IntegrationError(`${name} could not be reached (${(e as Error).name === 'TimeoutError' ? 'no answer in 15 seconds' : (e as Error).message}). Check the address.`);
  }
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (res.ok) return body as T;
  const said = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {}), body.message].filter(Boolean).join(' ').slice(0, 300);
  if (res.status === 401) throw new IntegrationError(`${name} refused the sign-in. Check the ${name === 'Jira' ? 'email and API token' : 'personal access token'}, and that it has not expired.`, 400);
  if (res.status === 403) throw new IntegrationError(`${name} says this account is not allowed to do that.${said ? ' ' + said : ''} Check the token's permissions.`, 400);
  if (res.status === 404) throw new IntegrationError(`${name} could not find it. Check the project${said ? `: ${said}` : '.'}`, 400);
  throw new IntegrationError(`${name} answered ${res.status}.${said ? ' ' + said : ''}`);
}

function jira<T = unknown>(send: typeof fetch, c: JiraConfig, token: string, method: string, path: string, body?: unknown): Promise<T> {
  return call<T>(send, c.site + path, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`${c.email}:${token}`).toString('base64'), accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 'Jira');
}

function ado<T = unknown>(send: typeof fetch, c: AdoConfig, token: string, method: string, path: string, body?: unknown, inProject = true, type = 'application/json'): Promise<T> {
  return call<T>(send, `${c.org}${inProject ? '/' + encodeURIComponent(c.project) : ''}${path}`, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(':' + token).toString('base64'), accept: 'application/json', ...(body ? { 'content-type': type } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 'Azure DevOps');
}
