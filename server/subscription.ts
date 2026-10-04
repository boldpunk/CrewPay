import { and, eq } from 'drizzle-orm';
import type { DB } from './db';
import { proGrants, proRequests, users } from './schema';

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

/**
 * Продлить Pro на `months` (от конца текущей подписки, если она ещё идёт); 0 — отключить.
 * Используют администратор и оплата через Payme / Click. Возвращает новый срок.
 */
export async function grantPro(db: DB | Tx, userId: string, months: number, by: string): Promise<Date | null> {
  const [u] = await db.select({ proUntil: users.proUntil }).from(users).where(eq(users.id, userId)).for('update').limit(1);
  if (!u) throw new Error('user not found');
  const from = u.proUntil && u.proUntil.getTime() > Date.now() ? u.proUntil : new Date();
  const until = months > 0 ? addMonths(from, months) : null;
  await db
    .update(users)
    .set({ proUntil: until, proSource: until ? 'paid' : null })
    .where(eq(users.id, userId));
  await db.insert(proGrants).values({ userId, months, until, grantedBy: by });
  await db
    .update(proRequests)
    .set({ status: months > 0 ? 'done' : 'rejected' })
    .where(and(eq(proRequests.userId, userId), eq(proRequests.status, 'open')));
  return until;
}

/** Возврат платежа: снять оплаченные месяцы. */
export async function revokeMonths(db: DB | Tx, userId: string, months: number, by: string): Promise<void> {
  const [u] = await db.select({ proUntil: users.proUntil }).from(users).where(eq(users.id, userId)).for('update').limit(1);
  if (!u?.proUntil) return;
  const until = addMonths(u.proUntil, -months);
  const active = until.getTime() > Date.now();
  await db
    .update(users)
    .set({ proUntil: active ? until : null, proSource: active ? 'paid' : null })
    .where(eq(users.id, userId));
  await db.insert(proGrants).values({ userId, months: -months, until: active ? until : null, grantedBy: by });
}
