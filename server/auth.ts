import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt, ne } from 'drizzle-orm';
import type { DB } from './db';
import { sessions, users } from './schema';

export const SESSION_COOKIE = 'crewpay_session';
export const SESSION_DAYS = 30;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 11);
}

/** Настоящий хеш для сравнения, когда email не найден: время ответа не выдаёт, кто зарегистрирован. */
export const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 11);

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Создаёт сессию и возвращает токен для cookie (в базе — только его хеш). */
export async function createSession(db: DB, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function userBySession(db: DB, token: string | undefined) {
  if (!token || token.length > 100) return null;
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt, proUntil: users.proUntil, proSource: users.proSource, status: users.status })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteSession(db: DB, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** После смены пароля — выйти на всех устройствах, кроме текущего (или везде, если токена нет). */
export async function deleteOtherSessions(db: DB, userId: string, keepToken?: string) {
  await db
    .delete(sessions)
    .where(keepToken ? and(eq(sessions.userId, userId), ne(sessions.id, sha256(keepToken))) : eq(sessions.userId, userId));
}

/** Временный пароль: без похожих символов (0/O, 1/l/I), чтобы его можно было продиктовать. */
export function tempPassword(length = 10): string {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

export async function purgeExpiredSessions(db: DB) {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

/** Простой ограничитель попыток входа: не больше `limit` за окно на ключ (IP + email). */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}
