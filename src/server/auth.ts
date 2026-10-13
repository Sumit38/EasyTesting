import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from '../db.js';

export interface User {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'tester';
}

interface Row extends User {
  password_hash: string;
  disabled: number;
  created_at: string;
}

const SESSION_DAYS = 7;
export const COOKIE = 'nh_session';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** scrypt with a random salt, stored as scrypt$N$salt$hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const N = 16384;
  const hash = scryptSync(password, salt, 64, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, n, salt, hash] = stored.split('$');
  return new Promise((done) =>
    scrypt(password, Buffer.from(salt, 'hex'), 64, { N: Number(n) }, (err, key) => {
      const expected = Buffer.from(hash, 'hex');
      done(!err && key.length === expected.length && timingSafeEqual(key, expected));
    }),
  );
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Accounts and sessions, in the application database. */
export class Auth {
  /** Failed sign-ins per address and email, for a short lockout. In memory: it resets on restart. */
  private readonly failures = new Map<string, { n: number; until: number }>();

  constructor(private readonly db: DatabaseSync) {}

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  list(): (User & { disabled: boolean; createdAt: string })[] {
    return (this.db.prepare('SELECT id, email, name, role, disabled, created_at FROM users ORDER BY id').all() as unknown as Row[]).map((r) => ({
      id: r.id, email: r.email, name: r.name, role: r.role, disabled: !!r.disabled, createdAt: r.created_at,
    }));
  }

  create(input: { email: string; name: string; password: string; role?: 'admin' | 'tester' }): User {
    const email = String(input.email ?? '').trim().toLowerCase();
    const name = (String(input.name ?? '').trim() || email.split('@')[0]).slice(0, 80);
    if (email.length > 120) throw new AuthError('That email address is too long.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AuthError('Enter a valid email address.');
    if (String(input.password ?? '').length < 8) throw new AuthError('The password needs at least 8 characters.');
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError('An account with that email already exists.', 409);
    const role = input.role === 'admin' ? 'admin' : 'tester';
    const res = this.db
      .prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(email, name, hashPassword(input.password), role, new Date().toISOString());
    return { id: Number(res.lastInsertRowid), email, name, role };
  }

  update(id: number, change: { role?: 'admin' | 'tester'; disabled?: boolean; password?: string; name?: string }): void {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as Row | undefined;
    if (!u) throw new AuthError('No such user.', 404);
    if ((change.disabled || change.role === 'tester') && u.role === 'admin' && this.adminCount() <= 1) throw new AuthError('There must be at least one active admin.', 409);
    if (change.password !== undefined) {
      if (change.password.length < 8) throw new AuthError('The password needs at least 8 characters.');
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(change.password), id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (change.role) this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(change.role, id);
    if (change.name?.trim()) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(change.name.trim(), id);
    if (change.disabled !== undefined) {
      this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(change.disabled ? 1 : 0, id);
      if (change.disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  }

  private adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  /** Checks the password and opens a session. Returns the token to put in the cookie. */
  async login(email: string, password: string, ip: string): Promise<{ user: User; token: string }> {
    const key = `${ip}|${String(email).toLowerCase()}`;
    const f = this.failures.get(key);
    if (f && f.n >= 5 && f.until > Date.now()) throw new AuthError('Too many failed attempts. Wait a minute and try again.', 429);
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase()) as unknown as Row | undefined;
    // Hash even for an unknown email so the response time does not reveal which emails exist.
    const ok = await verifyPassword(String(password ?? ''), row?.password_hash ?? 'scrypt$16384$00$00');
    if (!row || !ok || row.disabled) {
      this.failures.set(key, { n: (f?.n ?? 0) + 1, until: Date.now() + 60_000 });
      throw new AuthError('Wrong email or password.', 401);
    }
    this.failures.delete(key);
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha(token), row.id, now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString());
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
    return { user: { id: row.id, email: row.email, name: row.name, role: row.role }, token };
  }

  logout(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  }

  /** The signed-in user for a request's session cookie, if any. */
  fromRequest(req: IncomingMessage): User | undefined {
    const token = cookie(req, COOKIE);
    if (!token) return undefined;
    const row = this.db
      .prepare('SELECT u.id, u.email, u.name, u.role, u.disabled, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(sha(token)) as unknown as (User & { disabled: number; expires_at: string }) | undefined;
    if (!row || row.disabled || row.expires_at < new Date().toISOString()) return undefined;
    return { id: row.id, email: row.email, name: row.name, role: row.role };
  }
}

export function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
export const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
