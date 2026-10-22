import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from '../db.js';
import { readApk, type ApkInfo } from '../mobile/apk.js';

/** An Android app a tester uploaded. */
export interface MobileApp extends ApkInfo {
  id: number;
  owner: number;
  filename: string;
  size: number;
  sha256: string;
  createdAt: string;
}

/** One check the agent made on the tester's computer. */
export interface AgentCheck {
  id: string;
  ok: boolean | null; // null: could not tell
  detail: string;
}

export interface AgentReport {
  os: 'windows' | 'mac' | 'linux';
  host: string;
  agentVersion: string;
  checks: AgentCheck[];
  devices: { serial: string; state: string; model?: string; emulator: boolean }[];
  avds: string[];
  /** Where the agent saved each uploaded app on the tester's computer, for Appium's "app" setting. */
  apps: Record<string, string>;
  at: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Uploaded APKs, and the agents testers run on their own computers to use a phone or emulator. */
export class Mobile {
  /** One-time codes shown on screen, typed into the agent once to pair it. In memory: they live ten minutes. */
  private readonly codes = new Map<string, { owner: number; until: number }>();

  constructor(private readonly db: DatabaseSync, private readonly dir: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS mobile_apps (id INTEGER PRIMARY KEY AUTOINCREMENT, owner INTEGER NOT NULL, filename TEXT NOT NULL, info TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (token_hash TEXT PRIMARY KEY, owner INTEGER NOT NULL, created_at TEXT NOT NULL, last_seen TEXT, report TEXT)`);
    mkdirSync(join(dir, 'apps'), { recursive: true });
  }

  private file = (id: number) => join(this.dir, 'apps', `${id}.apk`);

  addApp(owner: number, filename: string, bytes: Uint8Array): MobileApp {
    const info = readApk(bytes);
    const now = new Date().toISOString();
    const res = this.db.prepare('INSERT INTO mobile_apps (owner, filename, info, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(owner, filename.slice(0, 200), JSON.stringify(info), bytes.length, createHash('sha256').update(bytes).digest('hex'), now);
    const id = Number(res.lastInsertRowid);
    writeFileSync(this.file(id), bytes);
    return this.app(id)!;
  }

  app(id: number): MobileApp | undefined {
    const r = this.db.prepare('SELECT * FROM mobile_apps WHERE id = ?').get(id) as { id: number; owner: number; filename: string; info: string; size: number; sha256: string; created_at: string } | undefined;
    return r ? { ...(JSON.parse(r.info) as ApkInfo), id: r.id, owner: r.owner, filename: r.filename, size: r.size, sha256: r.sha256, createdAt: r.created_at } : undefined;
  }

  apps(owner?: number): MobileApp[] {
    const rows = (owner === undefined ? this.db.prepare('SELECT id FROM mobile_apps ORDER BY id DESC').all() : this.db.prepare('SELECT id FROM mobile_apps WHERE owner = ? ORDER BY id DESC').all(owner)) as { id: number }[];
    return rows.map((r) => this.app(r.id)!).filter(Boolean);
  }

  apkBytes(id: number): Buffer | undefined {
    return existsSync(this.file(id)) ? readFileSync(this.file(id)) : undefined;
  }

  deleteApp(id: number): boolean {
    rmSync(this.file(id), { force: true });
    return Number(this.db.prepare('DELETE FROM mobile_apps WHERE id = ?').run(id).changes) > 0;
  }

  /** A short code to type into the agent: easy to read aloud, no 0/O or 1/I. */
  pairingCode(owner: number): { code: string; expiresAt: string } {
    for (const [k, c] of this.codes) if (c.until < Date.now()) this.codes.delete(k);
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 8 }, () => letters[randomInt(letters.length)]).join('').replace(/^(.{4})/, '$1-');
    const until = Date.now() + 10 * 60_000;
    this.codes.set(code, { owner, until });
    return { code, expiresAt: new Date(until).toISOString() };
  }

  /** Exchanges a pairing code (once) for the agent's own key. */
  pair(code: string): { token: string; owner: number } | undefined {
    const c = this.codes.get(String(code).trim().toUpperCase());
    if (!c || c.until < Date.now()) return undefined;
    this.codes.delete(String(code).trim().toUpperCase());
    const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO agents (token_hash, owner, created_at) VALUES (?, ?, ?)').run(sha(token), c.owner, new Date().toISOString());
    return { token, owner: c.owner };
  }

  /** The person an agent key belongs to. */
  agentOwner(token: string | undefined): number | undefined {
    if (!token) return undefined;
    return (this.db.prepare('SELECT owner FROM agents WHERE token_hash = ?').get(sha(token)) as { owner: number } | undefined)?.owner;
  }

  saveReport(token: string, report: AgentReport): void {
    this.db.prepare('UPDATE agents SET report = ?, last_seen = ? WHERE token_hash = ?').run(JSON.stringify(report), new Date().toISOString(), sha(token));
  }

  /** The newest report from any of this person's agents, and how long ago it came. */
  latest(owner: number): { report: AgentReport; lastSeen: string; online: boolean } | undefined {
    const r = this.db.prepare('SELECT report, last_seen FROM agents WHERE owner = ? AND report IS NOT NULL ORDER BY last_seen DESC LIMIT 1').get(owner) as { report: string; last_seen: string } | undefined;
    if (!r) return undefined;
    return { report: JSON.parse(r.report), lastSeen: r.last_seen, online: Date.now() - Date.parse(r.last_seen) < 30_000 };
  }

  /** Signs out every agent of this person: their keys stop working. */
  forgetAgents(owner: number): number {
    return Number(this.db.prepare('DELETE FROM agents WHERE owner = ?').run(owner).changes);
  }
}

/** Keeps only what a report may contain, with sizes limited: it comes from a program on someone else's computer. */
export function cleanReport(input: any): AgentReport {
  const s = (v: unknown, n = 300) => String(v ?? '').slice(0, n);
  const os = ['windows', 'mac', 'linux'].includes(input?.os) ? input.os : 'windows';
  return {
    os, host: s(input?.host, 80), agentVersion: s(input?.agentVersion, 20),
    checks: (Array.isArray(input?.checks) ? input.checks : []).slice(0, 30).map((c: any) => ({ id: s(c?.id, 40), ok: c?.ok === true ? true : c?.ok === false ? false : null, detail: s(c?.detail, 400) })),
    devices: (Array.isArray(input?.devices) ? input.devices : []).slice(0, 20).map((d: any) => ({ serial: s(d?.serial, 80), state: s(d?.state, 30), model: d?.model ? s(d.model, 80) : undefined, emulator: !!d?.emulator })),
    avds: (Array.isArray(input?.avds) ? input.avds : []).slice(0, 30).map((a: unknown) => s(a, 80)),
    apps: Object.fromEntries(Object.entries(input?.apps && typeof input.apps === 'object' ? input.apps : {}).slice(0, 50).map(([k, v]) => [s(k, 20), s(v, 400)])),
    at: new Date().toISOString(),
  };
}
