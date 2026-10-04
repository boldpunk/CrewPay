// Интеграционные тесты API на настоящем Postgres. Нужна переменная TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import regJson from '../public/regulation.json';
import { createApp } from '../server/app';
import { Pow, solve } from '../server/captcha';
import { createHash } from 'node:crypto';
import { connect, migrate, needsTls } from '../server/db';
import { extractItems } from '../server/pdftext';
import { parsePayslip, payslipToInput } from '../src/calc/payslip';
import type { Regulation } from '../src/calc/types';
import { fakePayslipItems, fakePayslipPdf } from './fixtures/fake-payslip';

const reg = regJson as Regulation;
const URL_ = process.env.TEST_DATABASE_URL;

describe('Подключение к базе', () => {
  it('TLS — только для облачной базы', () => {
    expect(needsTls('postgresql://crewpay:x@crewpay-db:5432/crewpay')).toBe(false);
    expect(needsTls('postgresql://postgres@127.0.0.1:5433/crewpay')).toBe(false);
    expect(needsTls('postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require')).toBe(true);
    expect(needsTls('postgresql://u:p@db.example.com/x?sslmode=disable')).toBe(false);
  });
});

describe('Парсер расчётного листка (синтетический листок)', () => {
  it('читает шапку, начисления и удержания', () => {
    const p = parsePayslip(fakePayslipItems());
    expect(p.month).toBe('2026-08');
    expect(p.name).toBe('IVANOVA ANNA PETROVNA');
    expect(p.employeeId).toBe('777');
    expect(p.organization).toBe('TEST AIRLINE MCHJ');
    expect(p.position).toBe('Бортпроводник-инструктор');
    expect(p.salaryRate).toBe(9_500_000);
    expect(p.gross).toBe(30_833_017.63);
    expect(p.net).toBe(27_133_055.51);
    expect(p.accruals.map((a) => a.label)).toEqual([
      'Оплата по окладу',
      'Оплата налета Dead head (50%)',
      'Оплата налёта до 70 часов включительно',
      'Оплата ночных часов',
      'Надбавка',
      'Медицинский осмотр',
    ]);
    expect(p.deductions.map((d) => d.label)).toEqual(['НДФЛ (в том числе ИНПС)', 'ИНПС']);
  });

  it('выводит норму, ставку и фактический Dead Head', () => {
    const i = payslipToInput(reg, parsePayslip(fakePayslipItems()));
    expect(i).toMatchObject({
      category: 'cabin',
      positionId: 'fa-instructor',
      norm: 25,
      worked: 23,
      hours: 56.2,
      nightHours: 0.79,
      deadheadHours: 6.9,
      rate: 220_000,
    });
    expect(i.extras).toEqual([
      { title: 'Надбавка', amount: 1_852_718.49 },
      { title: 'Медицинский осмотр', amount: 2_671_132.14 },
    ]);
  });

  it('читает настоящий PDF через pdf.js', async () => {
    const p = parsePayslip(await extractItems(await fakePayslipPdf()));
    expect(p.month).toBe('2026-08');
    expect(p.accruals).toHaveLength(6);
    expect(p.net).toBe(27_133_055.51);
  });
});

describe.skipIf(!URL_)('API (Postgres)', () => {
  const { db, pool } = connect(URL_ ?? 'postgres://x@localhost/x');
  const app = createApp({
    db,
    regulation: async () => reg,
    siteUrl: 'https://crewpay.test',
    pow: new Pow({ max: 2000, minMs: 0 }),
    registerLimit: 100,
    plan: { trialDays: 7, price: 29000, adminEmails: ['admin@example.com'] },
    payments: {
      payme: { merchantId: 'merchant-1', key: 'payme-key' },
      click: { serviceId: '111', merchantId: '222', secretKey: 'click-secret' },
    },
  });
  let cookie = '';

  const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== 'GET') headers.set('x-crewpay', '1');
    if (cookie) headers.set('cookie', cookie);
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      init.body = JSON.stringify(init.json);
    }
    return app.request(path, { ...init, headers });
  };

  /** Регистрация как в браузере: задача → перебор → отправка. */
  const register = async (json: Record<string, unknown>) => {
    const ch = await (await call('/api/auth/challenge')).json();
    return call('/api/auth/register', { method: 'POST', json: { ...json, captcha: solve(ch) } });
  };

  const state = {
    norm: '25',
    periods: [
      {
        category: 'cabin',
        positionId: 'fa-instructor',
        aircraft: -1,
        hours: '56,2',
        nightHours: '0,79',
        holidayHours: '',
        nightHolidayHours: '',
        deadheadHours: '6,9',
        worked: '23',
        statusId: 'full',
        salary: '9 500 000',
        rate: '220 000',
      },
    ],
    extras: [
      { title: 'Надбавка', amount: '1 852 718,49' },
      { title: 'Медицинский осмотр', amount: '2 671 132,14' },
    ],
    settings: { over94Mode: 'replace', proportionBasis: 'days' },
  };

  beforeAll(async () => {
    await pool.query('drop table if exists app_settings, click_transactions, payme_transactions, orders, pro_grants, pro_requests, payslips, months, profiles, sessions, users cascade');
    await migrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('без заголовка приложения изменяющие запросы отклоняются', async () => {
    const r = await app.request('/api/auth/login', { method: 'POST', body: '{}' });
    expect(r.status).toBe(403);
  });

  it('регистрация, вход, профиль', async () => {
    const weak = await register({ email: 'a@b.uz', password: '123' });
    expect(weak.status).toBe(400);

    const r = await register({ email: ' Test@Example.com ', password: 'correct horse', name: 'Test' });
    expect(r.status).toBe(201);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    const dup = await register({ email: 'test@example.com', password: 'another pass' });
    expect(dup.status).toBe(409);

    const me = await call('/api/me');
    expect(me.status).toBe(200);
    expect((await me.json()).user.email).toBe('test@example.com');

    const saved = await call('/api/profile', {
      method: 'PUT',
      json: { name: 'IVANOVA ANNA', employeeId: '777', salaries: { 'fa-instructor': '9 500 000' } },
    });
    expect(saved.status).toBe(200);

    await call('/api/auth/logout', { method: 'POST' });
    const gone = await call('/api/me');
    expect(gone.status).toBe(401);

    cookie = '';
    const bad = await call('/api/auth/login', { method: 'POST', json: { email: 'test@example.com', password: 'wrong pass' } });
    expect(bad.status).toBe(401);
    const unknown = await call('/api/auth/login', { method: 'POST', json: { email: 'nobody@example.com', password: 'whatever1' } });
    expect(unknown.status).toBe(401);
    const ok = await call('/api/auth/login', { method: 'POST', json: { email: 'TEST@example.com', password: 'correct horse' } });
    expect(ok.status).toBe(200);
    cookie = ok.headers.get('set-cookie')!.split(';')[0];
  });

  let payslipId = '';

  it('загрузка листка: распознаёт и сохраняет', async () => {
    const fd = new FormData();
    fd.set('file', new File([Buffer.from(await fakePayslipPdf())], 'Листок август.pdf', { type: 'application/pdf' }));
    const r = await call('/api/payslips', { method: 'POST', body: fd });
    expect(r.status).toBe(201);
    const j = await r.json();
    payslipId = j.id;
    expect(j.parsed.month).toBe('2026-08');
    expect(j.imported.norm).toBe(25);

    const notPdf = new FormData();
    notPdf.set('file', new File(['hello'], 'x.pdf'));
    expect((await call('/api/payslips', { method: 'POST', body: notPdf })).status).toBe(415);

    const file = await call(`/api/payslips/${payslipId}/file`);
    expect(file.headers.get('content-type')).toBe('application/pdf');
  });

  it('месяц: итоги считает сервер; сверка совпадает построчно', async () => {
    const r = await call('/api/months/2026-08', { method: 'PUT', json: { state, payslipId } });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.totals).toMatchObject({ total: 30_833_017.63, tax: 3_699_962.12, net: 27_133_055.51 });

    const list = await (await call('/api/months')).json();
    expect(list.months).toHaveLength(1);
    expect(list.months[0].payslipId).toBe(payslipId);

    const recon = await (await call('/api/reconcile', { method: 'POST', json: { month: '2026-08', state, payslipId } })).json();
    expect(recon.rows.length).toBe(7);
    expect(recon.rows.every((x: { ok: boolean }) => x.ok)).toBe(true);
  });

  it('PDF-отчёт', async () => {
    const r = await call('/api/report', { method: 'POST', json: { month: '2026-08', state, payslipId } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const text = (await extractItems(bytes)).map((i) => i.s).join(' ');
    expect(text).toContain('27 133 055,51');
    expect(text).toContain('crewpay.test');
  });

  it('журнал рейсов: сохраняется в месяце и попадает в PDF', async () => {
    const withFlights = {
      ...state,
      periods: [
        {
          ...state.periods[0],
          hours: '9,07',
          nightHours: '3,03',
          flights: [
            { id: 'f1', date: '2026-08-05', route: 'TAS-DXB', block: '6:00', night: '3:02', duty: '9:42', dh: false },
            { id: 'f2', date: '2026-08-06', route: 'DXB-TAS', block: '3:04', night: '', duty: '5:10', dh: false },
          ],
        },
      ],
    };
    const r = await call('/api/months/2026-08', { method: 'PUT', json: { state: withFlights, payslipId: null } });
    expect(r.status).toBe(200);
    const list = await (await call('/api/months')).json();
    expect(list.months[0].state.periods[0].flights).toHaveLength(2);

    const bad = await call('/api/months/2026-08', {
      method: 'PUT',
      json: { state: { ...withFlights, periods: [{ ...withFlights.periods[0], flights: [{ id: 'x', evil: true }] }] } },
    });
    expect(bad.status).toBe(400);

    const pdf = await call('/api/report', { method: 'POST', json: { month: '2026-08', state: withFlights } });
    const text = (await extractItems(new Uint8Array(await pdf.arrayBuffer()))).map((i) => i.s).join(' ');
    expect(text).toContain('Журнал рейсов');
    expect(text).toContain('TAS-DXB');
    expect(text).toContain('9:04');
  });

  it('чужие данные недоступны', async () => {
    cookie = '';
    const r = await register({ email: 'other@example.com', password: 'other password' });
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect((await call(`/api/payslips/${payslipId}/file`)).status).toBe(404);
    expect((await (await call('/api/months')).json()).months).toHaveLength(0);
  });

  it('защита от ботов: без решения, повтор, скрытое поле', async () => {
    cookie = '';
    const none = await call('/api/auth/register', { method: 'POST', json: { email: 'bot1@example.com', password: 'password1' } });
    expect(none.status).toBe(400);
    expect((await none.json()).code).toBe('captcha');

    const ch = await (await call('/api/auth/challenge')).json();
    const sol = solve(ch);
    const wrong = await call('/api/auth/register', {
      method: 'POST',
      json: { email: 'bot2@example.com', password: 'password1', captcha: { ...sol, number: (sol.number + 1) % 2001 } },
    });
    expect(wrong.status).toBe(400);
    const forged = await call('/api/auth/register', {
      method: 'POST',
      json: { email: 'bot2@example.com', password: 'password1', captcha: { ...sol, salt: sol.salt.replace(/\.\d+$/, '.0') } },
    });
    expect(forged.status).toBe(400);

    const honeypot = await call('/api/auth/register', {
      method: 'POST',
      json: { email: 'bot3@example.com', password: 'password1', captcha: sol, website: 'http://spam' },
    });
    expect(honeypot.status).toBe(400);

    const first = await call('/api/auth/register', { method: 'POST', json: { email: 'human@example.com', password: 'password1', captcha: sol } });
    expect(first.status).toBe(201);
    const replay = await call('/api/auth/register', { method: 'POST', json: { email: 'human2@example.com', password: 'password1', captcha: sol } });
    expect(replay.status).toBe(400);

    // Слишком быстрая отправка формы.
    const slow = new Pow({ max: 50, minMs: 60_000 });
    expect(slow.verify(solve(slow.create()))).toBe('too-fast');
    const old = new Pow({ max: 50, minMs: 0, ttlMs: 1000 });
    expect(old.verify(solve(old.create(Date.now() - 5000)))).toBe('expired');
  });

  it('подписка: пробный период, блокировка Pro-функций, заявка и выдача администратором', async () => {
    cookie = '';
    const r = await register({ email: 'pilot@example.com', password: 'password1' });
    expect((await r.json()).plan).toMatchObject({ pro: true, source: 'trial', admin: false });
    cookie = r.headers.get('set-cookie')!.split(';')[0];

    // Пробный период закончился.
    await pool.query(`update users set pro_until = now() - interval '1 day' where email = 'pilot@example.com'`);
    const me = await (await call('/api/me')).json();
    expect(me.plan.pro).toBe(false);
    const fd = new FormData();
    fd.set('file', new File([Buffer.from(await fakePayslipPdf())], 'x.pdf', { type: 'application/pdf' }));
    const locked = await call('/api/payslips', { method: 'POST', body: fd });
    expect(locked.status).toBe(402);
    expect((await locked.json()).code).toBe('pro');
    expect((await call('/api/report', { method: 'POST', json: { month: '2026-08', state } })).status).toBe(402);
    // Бесплатное остаётся бесплатным.
    expect((await call('/api/months/2026-08', { method: 'PUT', json: { state } })).status).toBe(200);

    expect((await call('/api/subscription/request', { method: 'POST', json: { months: 5 } })).status).toBe(400);
    const req = await call('/api/subscription/request', { method: 'POST', json: { months: 3, note: 'Telegram @pilot' } });
    expect(req.status).toBe(201);
    expect((await (await call('/api/me')).json()).request.months).toBe(3);
    expect((await call('/api/admin/subscriptions')).status).toBe(403);
    expect((await call('/api/admin/grant', { method: 'POST', json: { email: 'pilot@example.com', months: 12 } })).status).toBe(403);
    const pilotCookie = cookie;

    cookie = '';
    const a = await register({ email: 'admin@example.com', password: 'password1' });
    expect((await a.json()).plan).toMatchObject({ pro: true, admin: true });
    cookie = a.headers.get('set-cookie')!.split(';')[0];
    const list = await (await call('/api/admin/subscriptions')).json();
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({ email: 'pilot@example.com', months: 3, note: 'Telegram @pilot' });
    const found = await (await call('/api/admin/subscriptions?q=pilot')).json();
    expect(found.users.map((u: { email: string }) => u.email)).toEqual(['pilot@example.com']);
    expect((await call('/api/admin/grant', { method: 'POST', json: { email: 'nobody@example.com', months: 1 } })).status).toBe(404);
    const g = await (await call('/api/admin/grant', { method: 'POST', json: { email: 'pilot@example.com', months: 3 } })).json();
    expect(g.plan).toMatchObject({ pro: true, source: 'paid' });
    expect((await (await call('/api/admin/subscriptions')).json()).requests).toHaveLength(0);

    cookie = pilotCookie;
    const after = await (await call('/api/me')).json();
    expect(after.plan.pro).toBe(true);
    expect(after.request).toBeNull();
    const until = new Date(after.plan.until).getTime();
    expect(until).toBeGreaterThan(Date.now() + 85 * 864e5);
    expect((await call('/api/report', { method: 'POST', json: { month: '2026-08', state } })).status).toBe(200);

    cookie = a.headers.get('set-cookie')!.split(';')[0];
    await call('/api/admin/grant', { method: 'POST', json: { email: 'pilot@example.com', months: 0 } });
    cookie = pilotCookie;
    expect((await (await call('/api/me')).json()).plan.pro).toBe(false);
  });
  // ---------- оплата ----------

  let payKey = 'payme-key';
  const payme = async (method: string, params: Record<string, unknown>, key = payKey) => {
    const r = await app.request('/payments/payme', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`Paycom:${key}`).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { id: number; result: any; error?: { code: number; message: { ru: string } } };
  };
  const md5 = (x: string) => createHash('md5').update(x).digest('hex');
  const click = async (step: 'prepare' | 'complete', f: Record<string, string>, secret = 'click-secret') => {
    const action = step === 'prepare' ? '0' : '1';
    const base: Record<string, string> = { service_id: '111', click_paydoc_id: '9', action, sign_time: '2026-10-04 12:00:00', error: '0', error_note: 'Success', ...f };
    const sign = md5(
      base.click_trans_id + base.service_id + secret + base.merchant_trans_id + (step === 'complete' ? base.merchant_prepare_id : '') + base.amount + action + base.sign_time,
    );
    const r = await app.request(`/payments/click/${step}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...base, sign_string: sign }).toString(),
    });
    return r.json();
  };
  const planNow = async () => (await (await call('/api/me')).json()).plan;

  it('Payme: заказ, создание, оплата, проверка, выписка, возврат', async () => {
    cookie = '';
    const r = await register({ email: 'payer@example.com', password: 'password1' });
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    await pool.query(`update users set pro_until = null, pro_source = null where email = 'payer@example.com'`);

    const info = await (await call('/api/plan')).json();
    expect(info.providers).toEqual(['payme', 'click']);
    expect((await call('/api/pay/checkout', { method: 'POST', json: { provider: 'payme', months: 5 } })).status).toBe(400);
    const co = await (await call('/api/pay/checkout', { method: 'POST', json: { provider: 'payme', months: 3 } })).json();
    expect(co.url).toMatch(/^https:\/\/checkout\.paycom\.uz\//);
    const decoded = Buffer.from(co.url.split('/').pop(), 'base64').toString();
    expect(decoded).toBe(`m=merchant-1;ac.order_id=${co.orderId};a=8700000;c=https://crewpay.test/?paid=${co.orderId};l=ru`);
    const order = co.orderId as number;
    const account = { order_id: String(order) };

    expect((await payme('CheckPerformTransaction', { amount: 8_700_000, account }, 'wrong')).error!.code).toBe(-32504);
    expect((await payme('CheckPerformTransaction', { amount: 100, account })).error!.code).toBe(-31001);
    const unknown = await payme('CheckPerformTransaction', { amount: 8_700_000, account: { order_id: '999999' } });
    expect(unknown.error!.code).toBe(-31050);
    expect(unknown.error!.message.ru).toBeTruthy();
    expect(unknown.id).toBe(7);
    expect((await payme('CheckPerformTransaction', { amount: 8_700_000, account })).result).toEqual({ allow: true });

    const time = Date.now();
    const c1 = await payme('CreateTransaction', { id: 'pay-1', time, amount: 8_700_000, account });
    expect(c1.result.state).toBe(1);
    const again = await payme('CreateTransaction', { id: 'pay-1', time, amount: 8_700_000, account });
    expect(again.result).toEqual(c1.result);
    expect((await payme('CreateTransaction', { id: 'pay-2', time, amount: 8_700_000, account })).error!.code).toBe(-31050);
    expect((await payme('CheckPerformTransaction', { amount: 8_700_000, account })).error!.code).toBe(-31008);
    expect((await planNow()).pro).toBe(false);

    const perf = await payme('PerformTransaction', { id: 'pay-1' });
    expect(perf.result.state).toBe(2);
    expect((await payme('PerformTransaction', { id: 'pay-1' })).result).toEqual(perf.result);
    const plan = await planNow();
    expect(plan).toMatchObject({ pro: true, source: 'paid' });
    expect(new Date(plan.until).getTime()).toBeGreaterThan(Date.now() + 85 * 864e5);
    expect((await (await call(`/api/pay/orders/${order}`)).json()).order.status).toBe('paid');

    const check = await payme('CheckTransaction', { id: 'pay-1' });
    expect(check.result).toMatchObject({ state: 2, perform_time: perf.result.perform_time, cancel_time: 0, reason: null });
    const st = await payme('GetStatement', { from: time - 1000, to: time + 1000 });
    expect(st.result.transactions).toHaveLength(1);
    expect(st.result.transactions[0]).toMatchObject({ id: 'pay-1', amount: 8_700_000, account, state: 2 });

    const cancel = await payme('CancelTransaction', { id: 'pay-1', reason: 5 });
    expect(cancel.result.state).toBe(-2);
    expect((await payme('CancelTransaction', { id: 'pay-1', reason: 5 })).result).toEqual(cancel.result);
    expect((await planNow()).pro).toBe(false);
    expect((await payme('CheckTransaction', { id: 'pay-1' })).result).toMatchObject({ state: -2, reason: 5 });

    expect((await payme('PerformTransaction', { id: 'nope' })).error!.code).toBe(-31003);
    expect((await payme('Unknown', {})).error!.code).toBe(-32601);
  });

  it('Payme: отмена по таймауту 12 часов, отмена до оплаты, смена ключа', async () => {
    const co = await (await call('/api/pay/checkout', { method: 'POST', json: { provider: 'payme', months: 1 } })).json();
    const account = { order_id: String(co.orderId) };
    await payme('CreateTransaction', { id: 'pay-3', time: Date.now(), amount: 2_900_000, account });
    await pool.query(`update payme_transactions set create_time = create_time - 43300000 where payme_id = 'pay-3'`);
    expect((await payme('PerformTransaction', { id: 'pay-3' })).error!.code).toBe(-31008);
    expect((await payme('CheckTransaction', { id: 'pay-3' })).result).toMatchObject({ state: -1, reason: 4 });
    expect((await planNow()).pro).toBe(false);

    const co2 = await (await call('/api/pay/checkout', { method: 'POST', json: { provider: 'payme', months: 1 } })).json();
    await payme('CreateTransaction', { id: 'pay-4', time: Date.now(), amount: 2_900_000, account: { order_id: String(co2.orderId) } });
    expect((await payme('CancelTransaction', { id: 'pay-4', reason: 3 })).result.state).toBe(-1);
    expect((await (await call(`/api/pay/orders/${co2.orderId}`)).json()).order.status).toBe('cancelled');

    expect((await payme('ChangePassword', { password: 'new-key' })).result).toEqual({ success: true });
    expect((await payme('CheckTransaction', { id: 'pay-4' })).error!.code).toBe(-32504);
    payKey = 'new-key';
    expect((await payme('CheckTransaction', { id: 'pay-4' })).result.state).toBe(-1);
  });

  it('Click: подпись, сумма, prepare → complete, отмена, повторная оплата', async () => {
    const co = await (await call('/api/pay/checkout', { method: 'POST', json: { provider: 'click', months: 1 } })).json();
    expect(co.url).toContain('https://my.click.uz/services/pay?service_id=111&merchant_id=222&amount=29000');
    const tr = String(co.orderId);

    expect((await click('prepare', { click_trans_id: '5001', merchant_trans_id: tr, amount: '29000.00' }, 'bad')).error).toBe(-1);
    expect((await click('prepare', { click_trans_id: '5001', merchant_trans_id: tr, amount: '100' })).error).toBe(-2);
    expect((await click('prepare', { click_trans_id: '5001', merchant_trans_id: '999999', amount: '29000' })).error).toBe(-5);
    const prep = await click('prepare', { click_trans_id: '5001', merchant_trans_id: tr, amount: '29000.00' });
    expect(prep).toMatchObject({ error: 0, click_trans_id: 5001, merchant_trans_id: tr });
    expect(prep.merchant_prepare_id).toBeGreaterThan(0);

    expect(
      (await click('complete', { click_trans_id: '5001', merchant_trans_id: tr, merchant_prepare_id: '999', amount: '29000.00' })).error,
    ).toBe(-6);
    const done = await click('complete', { click_trans_id: '5001', merchant_trans_id: tr, merchant_prepare_id: String(prep.merchant_prepare_id), amount: '29000.00' });
    expect(done).toMatchObject({ error: 0, merchant_confirm_id: prep.merchant_prepare_id });
    expect((await planNow()).pro).toBe(true);
    const twice = await click('complete', { click_trans_id: '5001', merchant_trans_id: tr, merchant_prepare_id: String(prep.merchant_prepare_id), amount: '29000.00' });
    expect(twice.error).toBe(-4);
    expect((await click('prepare', { click_trans_id: '5002', merchant_trans_id: tr, amount: '29000' })).error).toBe(-4);

    // Списание не прошло — Click присылает complete с ошибкой.
    const co2 = await (await call('/api/pay/checkout', { method: 'POST', json: { provider: 'click', months: 1 } })).json();
    const p2 = await click('prepare', { click_trans_id: '5003', merchant_trans_id: String(co2.orderId), amount: '29000' });
    const failed = await click('complete', {
      click_trans_id: '5003',
      merchant_trans_id: String(co2.orderId),
      merchant_prepare_id: String(p2.merchant_prepare_id),
      amount: '29000',
      error: '-5017',
    });
    expect(failed.error).toBe(-9);
    expect((await (await call(`/api/pay/orders/${co2.orderId}`)).json()).order.status).toBe('cancelled');

    // Чужой заказ не виден.
    const other = cookie;
    cookie = '';
    const r = await register({ email: 'stranger@example.com', password: 'password1' });
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect((await call(`/api/pay/orders/${co.orderId}`)).status).toBe(404);
    cookie = other;
  });
});
