import { createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, between, eq, inArray, ne } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DB } from './db';
import { appSettings, clickTransactions, orders, paymeTransactions } from './schema';
import { type Tx, grantPro, revokeMonths } from './subscription';

/**
 * Оплата Pro: Payme (Merchant API, JSON-RPC) и Click (SHOP API, Prepare/Complete).
 * Платёжная система сама вызывает эти адреса; при успешной оплате Pro продлевается автоматически.
 * Адреса для кабинетов: https://crewpay.uz/payments/payme, https://crewpay.uz/payments/click/prepare и …/complete.
 */
export interface PaymentsConfig {
  payme?: {
    merchantId: string;
    key: string;
    /** Тестовая касса: checkout.test.paycom.uz. */
    test?: boolean;
    /** Поле счёта в кабинете Payme. */
    account?: string;
  };
  click?: { serviceId: string; merchantId: string; secretKey: string };
}

export type Provider = 'payme' | 'click';

export function enabledProviders(cfg: PaymentsConfig): Provider[] {
  return [...(cfg.payme ? (['payme'] as const) : []), ...(cfg.click ? (['click'] as const) : [])];
}

export function checkoutUrl(cfg: PaymentsConfig, provider: Provider, orderId: number, amountSum: number, returnUrl: string): string {
  if (provider === 'payme' && cfg.payme) {
    const p = cfg.payme;
    const params = `m=${p.merchantId};ac.${p.account ?? 'order_id'}=${orderId};a=${amountSum * 100};c=${returnUrl};l=ru`;
    const host = p.test ? 'https://checkout.test.paycom.uz' : 'https://checkout.paycom.uz';
    return `${host}/${Buffer.from(params).toString('base64')}`;
  }
  if (provider === 'click' && cfg.click) {
    const q = new URLSearchParams({
      service_id: cfg.click.serviceId,
      merchant_id: cfg.click.merchantId,
      amount: String(amountSum),
      transaction_param: String(orderId),
      return_url: returnUrl,
    });
    return `https://my.click.uz/services/pay?${q}`;
  }
  throw new Error(`Оплата через ${provider} не настроена`);
}

// ---------- Payme ----------

/** Транзакция, не завершённая за 12 часов, отменяется (требование Payme). */
export const PAYME_TIMEOUT = 43_200_000;

const PaymeError = {
  INTERNAL: -32400,
  AUTH: -32504,
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD: -32601,
  AMOUNT: -31001,
  TX_NOT_FOUND: -31003,
  CANNOT_CANCEL: -31007,
  CANNOT_PERFORM: -31008,
  ACCOUNT: -31050,
} as const;

const msg = (ru: string, uz: string, en: string) => ({ ru, uz, en });
const M = {
  auth: msg('Недостаточно привилегий', 'Ruxsat yo‘q', 'Insufficient privilege'),
  order: msg('Заказ не найден', 'Buyurtma topilmadi', 'Order not found'),
  amount: msg('Неверная сумма', 'Noto‘g‘ri summa', 'Incorrect amount'),
  busy: msg('Заказ уже оплачивается', 'Buyurtma to‘lanmoqda', 'Order is being paid'),
  state: msg('Заказ уже оплачен или отменён', 'Buyurtma to‘langan yoki bekor qilingan', 'Order is paid or cancelled'),
  tx: msg('Транзакция не найдена', 'Tranzaksiya topilmadi', 'Transaction not found'),
  expired: msg('Время ожидания оплаты истекло', 'To‘lov vaqti tugadi', 'Transaction timed out'),
  perform: msg('Невозможно выполнить операцию', 'Amalni bajarib bo‘lmaydi', 'Unable to perform operation'),
  method: msg('Метод не найден', 'Metod topilmadi', 'Method not found'),
  request: msg('Неверный запрос', 'Noto‘g‘ri so‘rov', 'Invalid request'),
  internal: msg('Системная ошибка', 'Tizim xatosi', 'Internal error'),
};

class RpcError extends Error {
  constructor(
    public code: number,
    public text: { ru: string; uz: string; en: string },
    public data?: string,
  ) {
    super(text.en);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type PaymeTx = typeof paymeTransactions.$inferSelect;

export function mountPayments(app: Hono<any>, db: DB, cfg: PaymentsConfig) {
  // ---------- Payme ----------

  /** Ключ кассы: Payme может сменить его методом ChangePassword — тогда новый хранится в базе. */
  const paymeKey = async () => {
    const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, 'payme_key')).limit(1);
    return row?.value ?? cfg.payme!.key;
  };

  const field = cfg.payme?.account ?? 'order_id';

  const txView = (t: PaymeTx) => ({
    create_time: t.createTime,
    perform_time: t.performTime,
    cancel_time: t.cancelTime,
    transaction: String(t.id),
    state: t.state,
    reason: t.reason,
  });

  app.post('/payments/payme', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    let id: unknown = null;
    const ok = (result: unknown) => c.json({ jsonrpc: '2.0', id, result });
    const fail = (e: RpcError) => c.json({ jsonrpc: '2.0', id, result: null, error: { code: e.code, message: e.text, data: e.data } });

    let body: { id?: unknown; method?: unknown; params?: Record<string, any> };
    try {
      body = await c.req.json();
    } catch {
      return fail(new RpcError(PaymeError.PARSE, M.request));
    }
    id = body?.id ?? null;
    try {
      if (!cfg.payme) throw new RpcError(PaymeError.AUTH, M.auth);
      const m = /^\s*Basic\s+(\S+)\s*$/i.exec(c.req.header('authorization') ?? '');
      const cred = m ? Buffer.from(m[1], 'base64').toString() : '';
      const pass = cred.slice(cred.indexOf(':') + 1);
      if (!m || !cred.includes(':') || !safeEqual(pass, await paymeKey())) throw new RpcError(PaymeError.AUTH, M.auth);
      if (typeof body.method !== 'string' || !body.params || typeof body.params !== 'object')
        throw new RpcError(PaymeError.INVALID_REQUEST, M.request);
      return ok(await paymeMethod(body.method, body.params));
    } catch (e) {
      if (e instanceof RpcError) return fail(e);
      console.error('payme', e);
      return fail(new RpcError(PaymeError.INTERNAL, M.internal));
    }
  });

  async function paymeMethod(method: string, p: Record<string, any>): Promise<unknown> {
    switch (method) {
      case 'CheckPerformTransaction':
        return db.transaction(async (tx) => {
          await payableOrder(tx, p);
          const busy = await tx
            .select({ id: paymeTransactions.id })
            .from(paymeTransactions)
            .where(and(eq(paymeTransactions.orderId, orderIdOf(p)), inArray(paymeTransactions.state, [1, 2])))
            .limit(1);
          if (busy.length) throw new RpcError(PaymeError.CANNOT_PERFORM, M.busy);
          return { allow: true };
        });

      case 'CreateTransaction':
        return afterCommit(async (tx) => {
          const paymeId = str(p.id);
          const order = await payableOrder(tx, p);
          const other = await tx
            .select({ id: paymeTransactions.id })
            .from(paymeTransactions)
            .where(
              and(eq(paymeTransactions.orderId, order.id), inArray(paymeTransactions.state, [1, 2]), ne(paymeTransactions.paymeId, paymeId)),
            )
            .limit(1);
          if (other.length) throw new RpcError(PaymeError.ACCOUNT, M.busy, field);
          const [found] = await tx.select().from(paymeTransactions).where(eq(paymeTransactions.paymeId, paymeId)).for('update').limit(1);
          if (found) {
            if (found.state !== 1) throw new RpcError(PaymeError.CANNOT_PERFORM, M.perform);
            if (Date.now() - found.createTime > PAYME_TIMEOUT) {
              await cancelPayme(tx, found, 4);
              return new RpcError(PaymeError.CANNOT_PERFORM, M.expired);
            }
            return { create_time: found.createTime, transaction: String(found.id), state: found.state };
          }
          const time = Number(p.time);
          if (!Number.isFinite(time)) throw new RpcError(PaymeError.INVALID_REQUEST, M.request, 'time');
          if (Date.now() - time > PAYME_TIMEOUT) throw new RpcError(PaymeError.ACCOUNT, M.expired, 'time');
          const [t] = await tx
            .insert(paymeTransactions)
            .values({ paymeId, orderId: order.id, amount: Number(p.amount), state: 1, paymeTime: time, createTime: Date.now() })
            .returning();
          return { create_time: t.createTime, transaction: String(t.id), state: t.state };
        });

      case 'PerformTransaction':
        return afterCommit(async (tx) => {
          const t = await paymeTx(tx, p);
          if (t.state === 2) return { transaction: String(t.id), perform_time: t.performTime, state: 2 };
          if (t.state !== 1) throw new RpcError(PaymeError.CANNOT_PERFORM, M.perform);
          if (Date.now() - t.createTime > PAYME_TIMEOUT) {
            await cancelPayme(tx, t, 4);
            return new RpcError(PaymeError.CANNOT_PERFORM, M.expired);
          }
          const [order] = await tx.select().from(orders).where(eq(orders.id, t.orderId)).for('update').limit(1);
          if (!order || order.status !== 'pending') throw new RpcError(PaymeError.CANNOT_PERFORM, M.state);
          const now = Date.now();
          await tx.update(orders).set({ status: 'paid', paidAt: new Date(now) }).where(eq(orders.id, order.id));
          await grantPro(tx, order.userId, order.months, `payme #${order.id}`);
          await tx.update(paymeTransactions).set({ state: 2, performTime: now }).where(eq(paymeTransactions.id, t.id));
          return { transaction: String(t.id), perform_time: now, state: 2 };
        });

      case 'CancelTransaction':
        return db.transaction(async (tx) => {
          const t = await paymeTx(tx, p);
          if (t.state === -1 || t.state === -2) return { transaction: String(t.id), cancel_time: t.cancelTime, state: t.state };
          const reason = Number.isInteger(p.reason) ? Number(p.reason) : null;
          const done = await cancelPayme(tx, t, reason);
          return { transaction: String(t.id), cancel_time: done.cancelTime, state: done.state };
        });

      case 'CheckTransaction': {
        const t = await paymeTx(db, p);
        return txView(t);
      }

      case 'GetStatement': {
        const from = Number(p.from);
        const to = Number(p.to);
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RpcError(PaymeError.INVALID_REQUEST, M.request);
        const rows = await db
          .select()
          .from(paymeTransactions)
          .where(between(paymeTransactions.paymeTime, from, to))
          .orderBy(asc(paymeTransactions.paymeTime));
        return {
          transactions: rows.map((t) => ({
            id: t.paymeId,
            time: t.paymeTime,
            amount: t.amount,
            account: { [field]: String(t.orderId) },
            ...txView(t),
            receivers: null,
          })),
        };
      }

      case 'ChangePassword': {
        const next = typeof p.password === 'string' ? p.password.trim() : '';
        if (!next) throw new RpcError(PaymeError.INVALID_REQUEST, M.request, 'password');
        await db
          .insert(appSettings)
          .values({ key: 'payme_key', value: next })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: new Date() } });
        return { success: true };
      }

      default:
        throw new RpcError(PaymeError.METHOD, M.method, method);
    }
  }

  /** Отмена по таймауту должна сохраниться, а Payme — получить ошибку: ошибку возвращаем, а бросаем после фиксации. */
  async function afterCommit(fn: (tx: Tx) => Promise<unknown>) {
    const r = await db.transaction(fn);
    if (r instanceof RpcError) throw r;
    return r;
  }

  const str = (v: unknown) => {
    if (typeof v !== 'string' || !v || v.length > 64) throw new RpcError(PaymeError.INVALID_REQUEST, M.request, 'id');
    return v;
  };

  function orderIdOf(p: Record<string, any>): number {
    const raw = p.account?.[field];
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n <= 0) throw new RpcError(PaymeError.ACCOUNT, M.order, field);
    return n;
  }

  async function payableOrder(tx: DB | Tx, p: Record<string, any>) {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderIdOf(p))).for('update').limit(1);
    if (!order) throw new RpcError(PaymeError.ACCOUNT, M.order, field);
    if (!Number.isFinite(Number(p.amount)) || Number(p.amount) !== order.amount * 100) throw new RpcError(PaymeError.AMOUNT, M.amount, 'amount');
    if (order.status !== 'pending') throw new RpcError(PaymeError.CANNOT_PERFORM, M.state);
    return order;
  }

  async function paymeTx(tx: DB | Tx, p: Record<string, any>) {
    const [t] = await tx.select().from(paymeTransactions).where(eq(paymeTransactions.paymeId, str(p.id))).for('update').limit(1);
    if (!t) throw new RpcError(PaymeError.TX_NOT_FOUND, M.tx);
    return t;
  }

  /** Отмена: до оплаты — заказ отменяется; после — возврат, оплаченные месяцы снимаются. */
  async function cancelPayme(tx: Tx, t: PaymeTx, reason: number | null) {
    const now = Date.now();
    const state = t.state === 2 ? -2 : -1;
    await tx.update(paymeTransactions).set({ state, cancelTime: now, reason }).where(eq(paymeTransactions.id, t.id));
    const [order] = await tx.select().from(orders).where(eq(orders.id, t.orderId)).for('update').limit(1);
    if (order) {
      if (state === -2 && order.status === 'paid') await revokeMonths(tx, order.userId, order.months, `payme #${order.id} возврат`);
      await tx.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, order.id));
    }
    return { state, cancelTime: now };
  }

  // ---------- Click ----------

  const ClickError = {
    OK: 0,
    SIGN: -1,
    AMOUNT: -2,
    ACTION: -3,
    PAID: -4,
    ORDER: -5,
    TX: -6,
    UPDATE: -7,
    REQUEST: -8,
    CANCELLED: -9,
  } as const;

  const readParams = async (c: Context): Promise<Record<string, string>> => {
    const type = c.req.header('content-type') ?? '';
    const raw = type.includes('json') ? await c.req.json() : await c.req.parseBody();
    return Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' ? String(v) : '']));
  };

  const md5 = (s: string) => createHash('md5').update(s).digest('hex');

  const clickHandler = (action: '0' | '1') => async (c: Context) => {
    let p: Record<string, string>;
    try {
      p = await readParams(c);
    } catch {
      return c.json({ error: ClickError.REQUEST, error_note: 'Error in request from click' });
    }
    const base = { click_trans_id: Number(p.click_trans_id) || p.click_trans_id, merchant_trans_id: p.merchant_trans_id };
    const reply = (error: number, error_note: string, extra: Record<string, unknown> = {}) => c.json({ ...base, ...extra, error, error_note });

    if (!cfg.click) return reply(ClickError.REQUEST, 'Click is not configured');
    const need = ['click_trans_id', 'service_id', 'merchant_trans_id', 'amount', 'action', 'sign_time', 'sign_string'];
    if (action === '1') need.push('merchant_prepare_id');
    if (need.some((k) => !p[k])) return reply(ClickError.REQUEST, 'Error in request from click');
    const sign = md5(
      p.click_trans_id + p.service_id + cfg.click.secretKey + p.merchant_trans_id + (action === '1' ? p.merchant_prepare_id : '') + p.amount + p.action + p.sign_time,
    );
    if (!safeEqual(sign, p.sign_string.toLowerCase()) || p.service_id !== cfg.click.serviceId) return reply(ClickError.SIGN, 'SIGN CHECK FAILED!');
    if (p.action !== action) return reply(ClickError.ACTION, 'Action not found');

    const orderId = Number(p.merchant_trans_id);
    const clickTransId = Number(p.click_trans_id);
    if (!Number.isSafeInteger(orderId) || !Number.isSafeInteger(clickTransId)) return reply(ClickError.ORDER, 'User does not exist');

    try {
      return await db.transaction(async (tx) => {
        const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update').limit(1);
        if (!order) return reply(ClickError.ORDER, 'User does not exist');
        if (Math.abs(Number(p.amount) - order.amount) > 0.001) return reply(ClickError.AMOUNT, 'Incorrect parameter amount');

        if (action === '0') {
          const [found] = await tx.select().from(clickTransactions).where(eq(clickTransactions.clickTransId, clickTransId)).limit(1);
          if (found) {
            if (found.state === 'cancelled') return reply(ClickError.CANCELLED, 'Transaction cancelled');
            if (found.state === 'completed') return reply(ClickError.PAID, 'Already paid');
            return reply(ClickError.OK, 'Success', { merchant_prepare_id: found.id });
          }
          if (order.status === 'paid') return reply(ClickError.PAID, 'Already paid');
          if (order.status !== 'pending') return reply(ClickError.CANCELLED, 'Transaction cancelled');
          const [t] = await tx
            .insert(clickTransactions)
            .values({ clickTransId, orderId, amount: p.amount, state: 'prepared' })
            .returning({ id: clickTransactions.id });
          return reply(ClickError.OK, 'Success', { merchant_prepare_id: t.id });
        }

        const [t] = await tx
          .select()
          .from(clickTransactions)
          .where(and(eq(clickTransactions.id, Number(p.merchant_prepare_id)), eq(clickTransactions.clickTransId, clickTransId)))
          .for('update')
          .limit(1);
        if (!t || t.orderId !== orderId) return reply(ClickError.TX, 'Transaction does not exist');
        if (t.state === 'completed') return reply(ClickError.PAID, 'Already paid');
        if (t.state === 'cancelled') return reply(ClickError.CANCELLED, 'Transaction cancelled');
        // Click сообщает, что списание не прошло: отменяем.
        if (Number(p.error) < 0) {
          await tx.update(clickTransactions).set({ state: 'cancelled' }).where(eq(clickTransactions.id, t.id));
          if (order.status === 'pending') await tx.update(orders).set({ status: 'cancelled' }).where(eq(orders.id, order.id));
          return reply(ClickError.CANCELLED, 'Transaction cancelled');
        }
        if (order.status === 'paid') return reply(ClickError.PAID, 'Already paid');
        if (order.status !== 'pending') return reply(ClickError.CANCELLED, 'Transaction cancelled');
        await tx.update(orders).set({ status: 'paid', paidAt: new Date() }).where(eq(orders.id, order.id));
        await grantPro(tx, order.userId, order.months, `click #${order.id}`);
        await tx.update(clickTransactions).set({ state: 'completed' }).where(eq(clickTransactions.id, t.id));
        return reply(ClickError.OK, 'Success', { merchant_confirm_id: t.id });
      });
    } catch (e) {
      console.error('click', e);
      return reply(ClickError.UPDATE, 'Failed to update user');
    }
  };

  app.post('/payments/click/prepare', bodyLimit({ maxSize: 16 * 1024 }), clickHandler('0'));
  app.post('/payments/click/complete', bodyLimit({ maxSize: 16 * 1024 }), clickHandler('1'));
}
