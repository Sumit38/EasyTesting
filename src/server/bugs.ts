import { transaction, type DatabaseSync } from '../db.js';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
/** open: found. fixed: someone says it is fixed, awaiting a re-test. verified: a later run passed. reopened: failed again after a fix. */
export type BugStatus = 'open' | 'fixed' | 'verified' | 'reopened' | 'not-a-bug' | 'wont-fix';

export interface BugEvent {
  at: string;
  runId?: string;
  event: string;
}

/** Where the ticket stands in Jira or Azure DevOps, as last read. */
export interface TicketStatus {
  name: string;
  category: 'todo' | 'doing' | 'done';
  at: string;
}

/** The Jira issue or Azure DevOps work item this bug was filed as. */
export interface Ticket {
  tool: 'jira' | 'ado';
  key: string;
  url: string;
  /** The user story it was linked to, if the tester chose one. */
  story?: { key: string; title: string; status?: string; url: string };
  createdAt: string;
  status?: TicketStatus;
}

export interface Bug {
  id: string;
  /** One bug per failing test: file plus title. */
  key: string;
  title: string;
  test: string;
  file?: string;
  severity: Severity;
  status: BugStatus;
  cause: 'assertion' | 'element-not-found' | 'timeout' | 'error';
  error: string;
  scenarioId?: string;
  firstRun: string;
  lastRun: string;
  occurrences: number;
  /** Result of the most recent re-test, once the bug has been tested again after being found. */
  retest?: { runId: string; result: 'passed' | 'failed'; at: string };
  ticket?: Ticket;
  history: BugEvent[];
}

interface Store {
  counter: number;
  bugs: Bug[];
}

/** The bugs of one project, stored in the application database. */
export class BugTracker {
  constructor(private readonly db: DatabaseSync, private readonly project: string) {}

  private load(): Store {
    const rows = this.db.prepare('SELECT data FROM bugs WHERE project = ? ORDER BY id').all(this.project) as { data: string }[];
    const bugs = rows.map((r) => JSON.parse(r.data) as Bug);
    const counter = bugs.reduce((n, b) => Math.max(n, Number(b.id.replace(/\D/g, '')) || 0), 0);
    return { counter, bugs };
  }
  private save(s: Store) {
    const put = this.db.prepare('INSERT INTO bugs (project, id, data) VALUES (?, ?, ?) ON CONFLICT(project, id) DO UPDATE SET data = excluded.data');
    for (const b of s.bugs) put.run(this.project, b.id, JSON.stringify(b));
  }
  /** Reads, changes and writes the project's bugs under one write lock, so two runs finishing together cannot lose updates. */
  private edit<T>(fn: (s: Store) => T): T {
    return transaction(this.db, () => {
      const s = this.load();
      const out = fn(s);
      this.save(s);
      return out;
    });
  }

  list(): Bug[] {
    return this.load().bugs;
  }

  /** Applies one run's results: new failures become bugs, passing tests verify old ones, repeat failures reopen them. */
  reconcile(runId: string, tests: ResultForBug[], severityFor: (t: ResultForBug) => { severity?: Severity; scenarioId?: string }): Bug[] {
    return this.edit((s) => this.applyRun(s, runId, tests, severityFor));
  }

  private applyRun(s: Store, runId: string, tests: ResultForBug[], severityFor: (t: ResultForBug) => { severity?: Severity; scenarioId?: string }): Bug[] {
    const now = new Date().toISOString();
    for (const t of tests) {
      const key = `${t.file ?? ''}::${t.title}`;
      const bug = s.bugs.find((b) => b.key === key && !['not-a-bug', 'wont-fix'].includes(b.status)) ?? s.bugs.find((b) => b.key === key);
      if (t.status === 'failed' || t.status === 'timedOut') {
        const error = t.errorLine || t.error || 'The test failed.';
        // A failure of an expectation the generator guessed is a question for a person, not a defect.
        if (!bug && t.assumed) continue;
        if (!bug) {
          const { severity, scenarioId } = severityFor(t);
          s.counter++;
          s.bugs.push({
            id: `BUG-${String(s.counter).padStart(3, '0')}`, key, title: `${t.title}: ${error.slice(0, 110)}`, test: t.title, file: t.file,
            severity: severity ?? guessSeverity(error), status: 'open', cause: classify(error), error: (t.error ?? error).slice(0, 1500), scenarioId,
            firstRun: runId, lastRun: runId, occurrences: 1, history: [{ at: now, runId, event: 'Found: the test failed' }],
          });
        } else if (bug.status === 'not-a-bug' || bug.status === 'wont-fix') {
          bug.lastRun = runId; // closed on purpose; keep it closed
        } else {
          bug.lastRun = runId;
          bug.occurrences++;
          bug.error = (t.error ?? error).slice(0, 1500);
          if (bug.status === 'fixed' || bug.status === 'verified') {
            bug.retest = { runId, result: 'failed', at: now };
            bug.history.push({ at: now, runId, event: bug.status === 'fixed' ? 'Re-test failed: reopened' : 'Failed again after being verified: reopened' });
            bug.status = 'reopened';
          } else bug.history.push({ at: now, runId, event: 'Still failing' });
        }
      } else if (t.status === 'passed' && bug && ['open', 'fixed', 'reopened'].includes(bug.status)) {
        bug.lastRun = runId;
        bug.retest = { runId, result: 'passed', at: now };
        bug.history.push({ at: now, runId, event: 'Re-test passed: verified fixed' });
        bug.status = 'verified';
      }
    }
    return s.bugs;
  }

  /** Records the ticket a bug was filed as. */
  setTicket(id: string, ticket: Ticket, by: string): Bug | undefined {
    return this.edit((s) => {
      const bug = s.bugs.find((b) => b.id === id);
      if (!bug) return undefined;
      bug.ticket = ticket;
      const where = ticket.tool === 'jira' ? 'Jira' : 'Azure DevOps';
      bug.history.push({ at: ticket.createdAt, event: `Filed in ${where} as ${ticket.key}${ticket.story ? `, linked to user story ${ticket.story.key}` : ''} by ${by}` });
      return bug;
    });
  }

  /** Stores the ticket's latest status, noting in the history when it changed. */
  setTicketStatus(id: string, status: TicketStatus): void {
    this.edit((s) => {
      const bug = s.bugs.find((b) => b.id === id);
      if (!bug?.ticket) return;
      if (bug.ticket.status?.name && bug.ticket.status.name !== status.name) bug.history.push({ at: status.at, event: `${bug.ticket.key} moved to "${status.name}"` });
      bug.ticket.status = status;
    });
  }

  /** A person changes a bug: its status, severity or a note. */
  update(id: string, change: { status?: BugStatus; severity?: Severity; note?: string }): Bug | undefined {
    return this.edit((s) => this.change(s, id, change));
  }

  private change(s: Store, id: string, change: { status?: BugStatus; severity?: Severity; note?: string }): Bug | undefined {
    const bug = s.bugs.find((b) => b.id === id);
    if (!bug) return undefined;
    const now = new Date().toISOString();
    if (change.severity && change.severity !== bug.severity) {
      bug.history.push({ at: now, event: `Severity changed from ${bug.severity} to ${change.severity}` });
      bug.severity = change.severity;
    }
    if (change.status && change.status !== bug.status) {
      const label: Record<BugStatus, string> = {
        open: 'Reopened by a person', fixed: 'Marked fixed: waiting for a re-test', verified: 'Marked verified', reopened: 'Reopened by a person',
        'not-a-bug': 'Closed as not a bug', 'wont-fix': "Closed as won't fix",
      };
      bug.history.push({ at: now, event: label[change.status] });
      bug.status = change.status;
    }
    if (change.note?.trim()) bug.history.push({ at: now, event: `Note: ${change.note.trim().slice(0, 500)}` });
    return bug;
  }
}

export interface ResultForBug {
  title: string;
  file?: string;
  status: string;
  error?: string;
  errorLine?: string;
  assumed?: boolean;
}

export function classify(error: string): Bug['cause'] {
  if (/expect\(|toHave|toBe|toEqual|toContain|AssertionError|assert/i.test(error)) return 'assertion';
  if (/no such element|waiting for (locator|selector)|not found|unable to locate|element is not/i.test(error)) return 'element-not-found';
  if (/timeout|timed out/i.test(error)) return 'timeout';
  return 'error';
}

/** Used when no scenario priority says otherwise: a wrong value is worse than a slow or missing element. */
export function guessSeverity(error: string): Severity {
  const cause = classify(error);
  return cause === 'assertion' ? 'high' : 'medium';
}
