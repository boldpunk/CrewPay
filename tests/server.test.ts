// Интеграционные тесты API на настоящем Postgres. Нужна переменная TEST_DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import regJson from '../public/regulation.json';
import { createApp } from '../server/app';
import { connect, migrate } from '../server/db';
import { extractItems } from '../server/pdftext';
import { parsePayslip, payslipToInput } from '../src/calc/payslip';
import type { Regulation } from '../src/calc/types';
import { fakePayslipItems, fakePayslipPdf } from './fixtures/fake-payslip';

const reg = regJson as Regulation;
const URL_ = process.env.TEST_DATABASE_URL;

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
  const app = createApp({ db, regulation: async () => reg, siteUrl: 'https://crewpay.test' });
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
    await pool.query('drop table if exists payslips, months, profiles, sessions, users cascade');
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
    const weak = await call('/api/auth/register', { method: 'POST', json: { email: 'a@b.uz', password: '123' } });
    expect(weak.status).toBe(400);

    const r = await call('/api/auth/register', {
      method: 'POST',
      json: { email: ' Test@Example.com ', password: 'correct horse', name: 'Test' },
    });
    expect(r.status).toBe(201);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);

    const dup = await call('/api/auth/register', { method: 'POST', json: { email: 'test@example.com', password: 'another pass' } });
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

  it('чужие данные недоступны', async () => {
    cookie = '';
    const r = await call('/api/auth/register', { method: 'POST', json: { email: 'other@example.com', password: 'other password' } });
    cookie = r.headers.get('set-cookie')!.split(';')[0];
    expect((await call(`/api/payslips/${payslipId}/file`)).status).toBe(404);
    expect((await (await call('/api/months')).json()).months).toHaveLength(0);
  });
});
