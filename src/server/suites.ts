import type { DatabaseSync } from '../db.js';
import type { TestCase } from '../cases/model.js';

export interface Suite {
  id: number;
  owner: number;
  title: string;
  /** 'generated' from a use case, 'uploaded' from a spreadsheet. */
  source: 'generated' | 'uploaded';
  usecaseId?: number;
  appUrl: string;
  cases: TestCase[];
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  owner: number;
  title: string;
  source: string;
  usecase_id: number | null;
  app_url: string;
  cases: string;
  created_at: string;
  updated_at: string;
}

const toSuite = (r: Row): Suite => ({
  id: r.id, owner: r.owner, title: r.title, source: r.source as Suite['source'], usecaseId: r.usecase_id ?? undefined, appUrl: r.app_url,
  cases: JSON.parse(r.cases), createdAt: r.created_at, updatedAt: r.updated_at,
});

/** Use cases and the test-case suites made from them or uploaded by testers. */
export class SuiteStore {
  constructor(private readonly db: DatabaseSync) {}

  addUseCase(owner: number, title: string, body: string): number {
    const res = this.db.prepare('INSERT INTO usecases (owner, title, body, created_at) VALUES (?, ?, ?, ?)').run(owner, title, body, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  getUseCase(id: number): { title: string; body: string } | undefined {
    return this.db.prepare('SELECT title, body FROM usecases WHERE id = ?').get(id) as unknown as { title: string; body: string } | undefined;
  }

  create(owner: number, input: { title: string; source: Suite['source']; usecaseId?: number; appUrl?: string; cases: TestCase[] }): Suite {
    const now = new Date().toISOString();
    const res = this.db
      .prepare('INSERT INTO suites (owner, title, source, usecase_id, app_url, cases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(owner, input.title.slice(0, 200), input.source, input.usecaseId ?? null, input.appUrl ?? '', JSON.stringify(input.cases), now, now);
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): Suite | undefined {
    const r = this.db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as unknown as Row | undefined;
    return r ? toSuite(r) : undefined;
  }

  /** Newest first. `owner` limits the list to one person; leave it out for everyone's. */
  list(owner?: number): Suite[] {
    const rows = (owner === undefined
      ? this.db.prepare('SELECT * FROM suites ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT * FROM suites WHERE owner = ? ORDER BY updated_at DESC').all(owner)) as unknown as Row[];
    return rows.map(toSuite);
  }

  update(id: number, change: { title?: string; appUrl?: string; cases?: TestCase[] }): Suite | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare('UPDATE suites SET title = ?, app_url = ?, cases = ?, updated_at = ? WHERE id = ?')
      .run((change.title ?? cur.title).slice(0, 200), change.appUrl ?? cur.appUrl, JSON.stringify(change.cases ?? cur.cases), new Date().toISOString(), id);
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM suites WHERE id = ?').run(id).changes > 0;
  }
}
