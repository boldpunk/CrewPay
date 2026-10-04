import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { calculateMonth } from '../src/calc/engine';
import { type Payslip, parsePayslip, payslipToInput, reconcile } from '../src/calc/payslip';
import { DEFAULT_SETTINGS, type Regulation, type Settings } from '../src/calc/types';
import { type AppState, sanitize, toMonthInput } from '../src/state';
import {
  DUMMY_HASH,
  RateLimiter,
  SESSION_COOKIE,
  SESSION_DAYS,
  createSession,
  deleteSession,
  hashPassword,
  normalizeEmail,
  userBySession,
  validEmail,
  verifyPassword,
} from './auth';
import { Pow } from './captcha';
import type { DB } from './db';
import { extractItems } from './pdftext';
import { renderReport } from './report';
import { months, payslips, profiles, proGrants, proRequests, users } from './schema';

export interface AppOptions {
  db: DB;
  /** Справочник читается на каждый запрос — администратор может менять файл на сервере. */
  regulation: () => Promise<Regulation>;
  /** Адрес сайта для PDF; по умолчанию — адрес, с которого пришёл запрос. */
  siteUrl?: string;
  secureCookies?: boolean;
  /** Проверка «не робот» при регистрации. */
  pow?: Pow;
  plan?: PlanOptions;
  /** Регистраций в час с одного IP. */
  registerLimit?: number;
}

export interface PlanOptions {
  /** Пробный Pro при регистрации, дней (0 — без пробного периода). */
  trialDays?: number;
  /** Цена Pro за месяц, сум. */
  price?: number;
  /** Кто выдаёт подписки (email через запятую в ADMIN_EMAIL). У администратора Pro всегда. */
  adminEmails?: string[];
  /** Куда писать об оплате (Telegram, страница оплаты) — показывается в заявке. */
  contactUrl?: string;
}

export const PRO_TERMS = [1, 3, 6, 12] as const;

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

type User = NonNullable<Awaited<ReturnType<typeof userBySession>>>;
type Env = { Variables: { user: User | null } };

const MAX_PDF = 5 * 1024 * 1024;

const periodSchema = z
  .object({
    category: z.enum(['pilot', 'cabin']),
    positionId: z.string().max(64),
    aircraft: z.number().int().min(-1).max(20),
    hours: z.string().max(20),
    nightHours: z.string().max(20),
    holidayHours: z.string().max(20),
    nightHolidayHours: z.string().max(20),
    deadheadHours: z.string().max(20),
    worked: z.string().max(20),
    statusId: z.string().max(32),
    salary: z.string().max(32),
    rate: z.string().max(32),
    flights: z
      .array(
        z
          .object({
            id: z.string().max(40),
            date: z.string().max(10),
            route: z.string().max(40),
            block: z.string().max(10),
            night: z.string().max(10),
            duty: z.string().max(10),
            dh: z.boolean(),
          })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();

const stateSchema = z.object({
  norm: z.string().max(20),
  periods: z.array(periodSchema).min(1).max(4),
  extras: z.array(z.object({ title: z.string().max(80), amount: z.string().max(32) })).max(20),
  settings: z.object({ over94Mode: z.enum(['replace', 'additive']), proportionBasis: z.enum(['days', 'hours']) }),
});

const monthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const profileSchema = z.object({
  name: z.string().max(120).default(''),
  employeeId: z.string().max(32).default(''),
  organization: z.string().max(120).default(''),
  department: z.string().max(120).default(''),
  salaries: z.record(z.string().max(64), z.string().max(32)).default({}),
  settings: z.record(z.string().max(32), z.string().max(32)).default({}),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
});

function totalsOf(reg: Regulation, month: string, st: z.infer<typeof stateSchema>) {
  const state = sanitize(reg, { ...st, month } as Partial<AppState>);
  const r = calculateMonth(reg, st.settings as Settings, toMonthInput(state));
  if (r.errors.length) return { errors: r.errors };
  return { total: r.total, net: r.net, tax: r.tax, piece: r.piece, time: r.time, extras: r.extras };
}

export function createApp(opts: AppOptions) {
  const { db } = opts;
  const app = new Hono<Env>();
  const pow = opts.pow ?? new Pow();
  const trialDays = opts.plan?.trialDays ?? 7;
  const admins = new Set((opts.plan?.adminEmails ?? []).map(normalizeEmail).filter(Boolean));
  const challengeLimiter = new RateLimiter(30, 10 * 60_000);
  const requestLimiter = new RateLimiter(10, 60 * 60_000);
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const registerLimiter = new RateLimiter(opts.registerLimit ?? 5, 60 * 60_000);

  const ip = (c: Context) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local';

  const siteUrl = (c: Context) => {
    if (opts.siteUrl) return opts.siteUrl.replace(/\/$/, '');
    const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? new URL(c.req.url).host;
    return `${proto}://${host}`;
  };

  const setSession = (c: Context, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: opts.secureCookies ?? false,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_DAYS * 86400,
    });

  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));

  // Все изменяющие запросы — только из своего приложения: заголовок, который нельзя отправить с чужого сайта без CORS.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.header('x-crewpay') !== '1')
      return c.json({ error: 'Запрос отклонён' }, 403);
    c.set('user', await userBySession(db, getCookie(c, SESSION_COOKIE)));
    await next();
  });

  const requireUser = (c: Context<Env>) => {
    const u = c.get('user');
    if (!u) throw new HttpError(401, 'Войдите в аккаунт');
    return u;
  };

  const planOf = (u: Pick<User, 'email' | 'proUntil' | 'proSource'>) => {
    const admin = admins.has(u.email);
    const until = u.proUntil ? new Date(u.proUntil) : null;
    return {
      pro: admin || (!!until && until.getTime() > Date.now()),
      until: admin ? null : (until?.toISOString() ?? null),
      source: admin ? 'admin' : (u.proSource ?? null),
      admin,
    };
  };

  const requirePro = (c: Context<Env>) => {
    const u = requireUser(c);
    if (!planOf(u).pro) throw new HttpError(402, 'Доступно в CrewPay Pro', 'pro');
    return u;
  };

  const requireAdmin = (c: Context<Env>) => {
    const u = requireUser(c);
    if (!admins.has(u.email)) throw new HttpError(403, 'Только для администратора');
    return u;
  };

  const openRequest = async (userId: string) => {
    const [r] = await db
      .select({ id: proRequests.id, months: proRequests.months, createdAt: proRequests.createdAt })
      .from(proRequests)
      .where(and(eq(proRequests.userId, userId), eq(proRequests.status, 'open')))
      .limit(1);
    return r ?? null;
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: 'Проверьте введённые данные', details: err.issues.slice(0, 5) }, 400);
    console.error(err);
    return c.json({ error: 'Ошибка сервера' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------- аккаунт ----------

  const credentials = z.object({ email: z.string(), password: z.string() });

  app.get('/api/auth/challenge', (c) => {
    if (!challengeLimiter.take(ip(c))) throw new HttpError(429, 'Слишком много запросов, попробуйте позже');
    c.header('cache-control', 'no-store');
    return c.json(pow.create());
  });

  const captchaSchema = z.object({
    salt: z.string().max(200),
    number: z.number(),
    challenge: z.string().max(200),
    signature: z.string().max(200),
  });

  app.post('/api/auth/register', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const body = credentials
      .extend({ name: z.string().max(120).optional(), captcha: captchaSchema.optional(), website: z.string().max(200).optional() })
      .parse(await c.req.json());
    // Скрытое поле: человек его не видит, бот заполняет.
    if (body.website) throw new HttpError(400, 'Запрос отклонён');
    const verdict = pow.verify(body.captcha);
    if (verdict !== 'ok')
      throw new HttpError(
        400,
        verdict === 'too-fast'
          ? 'Слишком быстро — проверьте данные и отправьте ещё раз'
          : verdict === 'expired'
            ? 'Проверка устарела — отправьте ещё раз'
            : 'Проверка «не робот» не пройдена — обновите страницу',
        'captcha',
      );
    if (!registerLimiter.take(ip(c))) throw new HttpError(429, 'Слишком много регистраций, попробуйте позже');
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) throw new HttpError(400, 'Проверьте email');
    if (body.password.length < 8) throw new HttpError(400, 'Пароль — минимум 8 символов');
    if (body.password.length > 200) throw new HttpError(400, 'Слишком длинный пароль');
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (exists.length) throw new HttpError(409, 'Этот email уже зарегистрирован — войдите');
    const [u] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(body.password),
        name: (body.name ?? '').trim(),
        proUntil: trialDays > 0 ? new Date(Date.now() + trialDays * 864e5) : null,
        proSource: trialDays > 0 ? 'trial' : null,
      })
      .returning({ id: users.id, email: users.email, name: users.name, proUntil: users.proUntil, proSource: users.proSource });
    await db.insert(profiles).values({ userId: u.id, data: { name: u.name } });
    const s = await createSession(db, u.id);
    setSession(c, s.token);
    return c.json({ user: { id: u.id, email: u.email, name: u.name }, plan: planOf(u) }, 201);
  });

  app.post('/api/auth/login', bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    const body = credentials.parse(await c.req.json());
    const email = normalizeEmail(body.email);
    const key = `${ip(c)}|${email}`;
    if (!loginLimiter.take(key)) throw new HttpError(429, 'Слишком много попыток, подождите 15 минут');
    const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    // Сравниваем хеш и для несуществующего email, чтобы время ответа не выдавало, кто зарегистрирован.
    const ok = await verifyPassword(body.password, u?.passwordHash ?? DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, 'Неверный email или пароль');
    loginLimiter.reset(key);
    const s = await createSession(db, u.id);
    setSession(c, s.token);
    return c.json({ user: { id: u.id, email: u.email, name: u.name }, plan: planOf(u) });
  });

  app.post('/api/auth/logout', async (c) => {
    await deleteSession(db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.get('/api/me', async (c) => {
    const u = requireUser(c);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, u.id)).limit(1);
    return c.json({
      user: { id: u.id, email: u.email, name: u.name, createdAt: u.createdAt },
      profile: p?.data ?? {},
      plan: planOf(u),
      request: await openRequest(u.id),
    });
  });

  // ---------- подписка ----------

  app.get('/api/plan', (c) =>
    c.json({ price: opts.plan?.price ?? 0, trialDays, terms: PRO_TERMS, contactUrl: opts.plan?.contactUrl ?? '' }),
  );

  app.post('/api/subscription/request', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const u = requireUser(c);
    if (!requestLimiter.take(u.id)) throw new HttpError(429, 'Слишком много заявок, попробуйте позже');
    const body = z
      .object({ months: z.number().int().refine((m) => (PRO_TERMS as readonly number[]).includes(m)), note: z.string().max(300).default('') })
      .parse(await c.req.json());
    const open = await openRequest(u.id);
    if (open) await db.update(proRequests).set({ months: body.months, note: body.note, createdAt: new Date() }).where(eq(proRequests.id, open.id));
    else await db.insert(proRequests).values({ userId: u.id, months: body.months, note: body.note });
    return c.json({ request: await openRequest(u.id) }, open ? 200 : 201);
  });

  app.delete('/api/subscription/request', async (c) => {
    const u = requireUser(c);
    await db
      .update(proRequests)
      .set({ status: 'cancelled' })
      .where(and(eq(proRequests.userId, u.id), eq(proRequests.status, 'open')));
    return c.json({ ok: true });
  });

  app.get('/api/admin/subscriptions', async (c) => {
    requireAdmin(c);
    const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 100);
    const requests = await db
      .select({ id: proRequests.id, months: proRequests.months, note: proRequests.note, createdAt: proRequests.createdAt, email: users.email, name: users.name, proUntil: users.proUntil })
      .from(proRequests)
      .innerJoin(users, eq(users.id, proRequests.userId))
      .where(eq(proRequests.status, 'open'))
      .orderBy(desc(proRequests.createdAt))
      .limit(100);
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    const list = await db
      .select({ email: users.email, name: users.name, proUntil: users.proUntil, proSource: users.proSource, createdAt: users.createdAt })
      .from(users)
      .where(q ? or(ilike(users.email, like), ilike(users.name, like)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(50);
    return c.json({ requests, users: list.map((x) => ({ ...x, plan: planOf(x) })) });
  });

  app.post('/api/admin/grant', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const admin = requireAdmin(c);
    const body = z.object({ email: z.string().max(254), months: z.number().int().min(0).max(36) }).parse(await c.req.json());
    const [u] = await db
      .select({ id: users.id, email: users.email, proUntil: users.proUntil, proSource: users.proSource })
      .from(users)
      .where(eq(users.email, normalizeEmail(body.email)))
      .limit(1);
    if (!u) throw new HttpError(404, 'Пользователь с таким email не найден');
    // Продлеваем от конца текущей подписки, если она ещё идёт; 0 месяцев — отключить Pro.
    const from = u.proUntil && u.proUntil.getTime() > Date.now() ? u.proUntil : new Date();
    const until = body.months > 0 ? addMonths(from, body.months) : null;
    await db
      .update(users)
      .set({ proUntil: until, proSource: until ? 'paid' : null })
      .where(eq(users.id, u.id));
    await db.insert(proGrants).values({ userId: u.id, months: body.months, until, grantedBy: admin.email });
    await db
      .update(proRequests)
      .set({ status: body.months > 0 ? 'done' : 'rejected' })
      .where(and(eq(proRequests.userId, u.id), eq(proRequests.status, 'open')));
    return c.json({ email: u.email, plan: planOf({ email: u.email, proUntil: until, proSource: until ? 'paid' : null }) });
  });

  app.post('/api/admin/requests/:id/reject', async (c) => {
    requireAdmin(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    await db.update(proRequests).set({ status: 'rejected' }).where(and(eq(proRequests.id, id), eq(proRequests.status, 'open')));
    return c.json({ ok: true });
  });

  app.put('/api/profile', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const u = requireUser(c);
    const data = profileSchema.parse(await c.req.json());
    await db
      .insert(profiles)
      .values({ userId: u.id, data, updatedAt: new Date() })
      .onConflictDoUpdate({ target: profiles.userId, set: { data, updatedAt: new Date() } });
    if (data.name && data.name !== u.name) await db.update(users).set({ name: data.name }).where(eq(users.id, u.id));
    return c.json({ profile: data });
  });

  // ---------- месяцы ----------

  app.get('/api/months', async (c) => {
    const u = requireUser(c);
    const rows = await db
      .select({ month: months.month, state: months.state, totals: months.totals, payslipId: months.payslipId, updatedAt: months.updatedAt })
      .from(months)
      .where(eq(months.userId, u.id))
      .orderBy(desc(months.month));
    return c.json({ months: rows });
  });

  app.put('/api/months/:month', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const u = requireUser(c);
    const month = monthKey.parse(c.req.param('month'));
    const body = z.object({ state: stateSchema, payslipId: z.string().uuid().nullable().optional() }).parse(await c.req.json());
    const reg = await opts.regulation();
    // Итоги считает сервер — им можно доверять в истории и отчётах.
    const totals = totalsOf(reg, month, body.state);
    if ('errors' in totals) throw new HttpError(422, totals.errors!.join(' '));
    let payslipId = body.payslipId ?? null;
    if (payslipId) {
      const own = await db.select({ id: payslips.id }).from(payslips).where(and(eq(payslips.id, payslipId), eq(payslips.userId, u.id))).limit(1);
      if (!own.length) payslipId = null;
    }
    const values = { state: body.state, totals, payslipId, updatedAt: new Date() };
    await db
      .insert(months)
      .values({ userId: u.id, month, ...values })
      .onConflictDoUpdate({ target: [months.userId, months.month], set: values });
    return c.json({ month, totals, payslipId });
  });

  app.delete('/api/months/:month', async (c) => {
    const u = requireUser(c);
    const month = monthKey.parse(c.req.param('month'));
    await db.delete(months).where(and(eq(months.userId, u.id), eq(months.month, month)));
    return c.json({ ok: true });
  });

  // ---------- расчётные листки ----------

  app.post('/api/payslips', bodyLimit({ maxSize: MAX_PDF + 64 * 1024 }), async (c) => {
    const u = requirePro(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new HttpError(400, 'Прикрепите PDF расчётного листка');
    if (file.size > MAX_PDF) throw new HttpError(413, 'Файл больше 5 МБ');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new HttpError(415, 'Это не PDF-файл');

    let parsed: Payslip;
    try {
      parsed = parsePayslip(await extractItems(bytes.slice()));
    } catch {
      throw new HttpError(422, 'Не удалось прочитать PDF');
    }
    if (!parsed.month || !parsed.accruals.length)
      throw new HttpError(422, 'Не похоже на расчётный листок: не найдены месяц и начисления');

    const reg = await opts.regulation();
    const imported = payslipToInput(reg, parsed);
    const [row] = await db
      .insert(payslips)
      .values({ userId: u.id, month: parsed.month, filename: file.name.slice(0, 200) || 'payslip.pdf', file: Buffer.from(bytes), parsed })
      .returning({ id: payslips.id, createdAt: payslips.createdAt });
    return c.json({ id: row.id, filename: file.name, createdAt: row.createdAt, parsed, imported }, 201);
  });

  app.get('/api/payslips', async (c) => {
    const u = requireUser(c);
    const rows = await db
      .select({ id: payslips.id, month: payslips.month, filename: payslips.filename, parsed: payslips.parsed, createdAt: payslips.createdAt })
      .from(payslips)
      .where(eq(payslips.userId, u.id))
      .orderBy(desc(payslips.createdAt));
    return c.json({ payslips: rows });
  });

  app.get('/api/payslips/:id/file', async (c) => {
    const u = requireUser(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    const [row] = await db.select().from(payslips).where(and(eq(payslips.id, id), eq(payslips.userId, u.id))).limit(1);
    if (!row) throw new HttpError(404, 'Листок не найден');
    return new Response(new Uint8Array(row.file), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'cache-control': 'private, no-store',
      },
    });
  });

  app.delete('/api/payslips/:id', async (c) => {
    const u = requireUser(c);
    const id = z.string().uuid().parse(c.req.param('id'));
    await db.update(months).set({ payslipId: null }).where(and(eq(months.userId, u.id), eq(months.payslipId, id)));
    await db.delete(payslips).where(and(eq(payslips.id, id), eq(payslips.userId, u.id)));
    return c.json({ ok: true });
  });

  // ---------- PDF-отчёт ----------

  app.post('/api/report', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const u = requirePro(c);
    const body = z
      .object({
        month: monthKey,
        state: stateSchema,
        payslipId: z.string().uuid().nullable().optional(),
        profile: profileSchema.partial().optional(),
      })
      .parse(await c.req.json());
    const reg = await opts.regulation();

    let profile = body.profile ?? null;
    if (u) {
      const [p] = await db.select().from(profiles).where(eq(profiles.userId, u.id)).limit(1);
      profile = { ...(p?.data as object), ...(profile ?? {}) };
    }

    let recon = null;
    if (u && body.payslipId) {
      const [ps] = await db
        .select({ parsed: payslips.parsed, filename: payslips.filename, createdAt: payslips.createdAt })
        .from(payslips)
        .where(and(eq(payslips.id, body.payslipId), eq(payslips.userId, u.id)))
        .limit(1);
      if (ps) {
        const state = sanitize(reg, { ...body.state, month: body.month } as Partial<AppState>);
        recon = {
          rows: reconcile(reg, body.state.settings as Settings, ps.parsed as Payslip, toMonthInput(state)),
          filename: ps.filename,
          uploadedAt: ps.createdAt,
        };
      }
    }

    const state = sanitize(reg, { ...body.state, month: body.month } as Partial<AppState>);
    let pdf: Buffer;
    try {
      pdf = await renderReport(reg, {
        month: body.month,
        state: { norm: state.norm, periods: state.periods, extras: state.extras, settings: { ...DEFAULT_SETTINGS, ...body.state.settings } },
        profile,
        recon,
        siteUrl: siteUrl(c),
        generatedAt: new Date(),
      });
    } catch (e) {
      throw new HttpError(422, e instanceof Error ? e.message : 'Не удалось построить отчёт');
    }
    const name = `CrewPay-${body.month}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // Реконсиляция отдельно — для экрана загрузки (без сохранения).
  app.post('/api/reconcile', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const u = requirePro(c);
    const body = z.object({ month: monthKey, state: stateSchema, payslipId: z.string().uuid() }).parse(await c.req.json());
    const [ps] = await db
      .select({ parsed: payslips.parsed })
      .from(payslips)
      .where(and(eq(payslips.id, body.payslipId), eq(payslips.userId, u.id)))
      .limit(1);
    if (!ps) throw new HttpError(404, 'Листок не найден');
    const reg = await opts.regulation();
    const state = sanitize(reg, { ...body.state, month: body.month } as Partial<AppState>);
    return c.json({ rows: reconcile(reg, body.state.settings as Settings, ps.parsed as Payslip, toMonthInput(state)) });
  });

  app.all('/api/*', (c) => c.json({ error: 'Не найдено' }, 404));

  return app;
}

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 422 | 429,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
