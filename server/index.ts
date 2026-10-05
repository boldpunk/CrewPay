import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Regulation } from '../src/calc/types';
import { createApp } from './app';
import { purgeExpiredSessions } from './auth';
import { Pow } from './captcha';
import { connect, migrate } from './db';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url));
// Справочник ставок не лежит среди статических файлов: его получают только пользователи с открытым доступом.
// Можно вынести в том (volume) и править без пересборки.
const REGULATION_PATH = process.env.REGULATION_PATH ?? fileURLToPath(new URL('../data/regulation.json', import.meta.url));

let cached: { mtime: number; reg: Regulation } | null = null;
async function regulation(): Promise<Regulation> {
  const s = await stat(REGULATION_PATH);
  if (!cached || cached.mtime !== s.mtimeMs) {
    cached = { mtime: s.mtimeMs, reg: JSON.parse(await readFile(REGULATION_PATH, 'utf8')) as Regulation };
  }
  return cached.reg;
}

const { db, pool } = connect(DATABASE_URL);
await migrate(pool);
await regulation();

const app = createApp({
  db,
  regulation,
  siteUrl: process.env.SITE_URL,
  secureCookies: process.env.NODE_ENV === 'production',
  // Без CAPTCHA_SECRET ключ создаётся при запуске: после перезапуска старые задачи просто устареют.
  pow: new Pow({ secret: process.env.CAPTCHA_SECRET || undefined }),
  payments: {
    payme:
      process.env.PAYME_MERCHANT_ID && process.env.PAYME_KEY
        ? {
            merchantId: process.env.PAYME_MERCHANT_ID,
            key: process.env.PAYME_KEY,
            test: process.env.PAYME_TEST === '1' || process.env.PAYME_TEST === 'true',
            account: process.env.PAYME_ACCOUNT || 'order_id',
          }
        : undefined,
    click:
      process.env.CLICK_SERVICE_ID && process.env.CLICK_MERCHANT_ID && process.env.CLICK_SECRET_KEY
        ? { serviceId: process.env.CLICK_SERVICE_ID, merchantId: process.env.CLICK_MERCHANT_ID, secretKey: process.env.CLICK_SECRET_KEY }
        : undefined,
  },
  legal: {
    operator: process.env.LEGAL_OPERATOR ?? '',
    inn: process.env.LEGAL_INN ?? '',
    email: process.env.CONTACT_EMAIL ?? '',
    telegram: process.env.CONTACT_TELEGRAM ?? '',
    phone: process.env.CONTACT_PHONE ?? '',
  },
  plan: {
    trialDays: Number(process.env.PRO_TRIAL_DAYS || 7),
    price: Number(process.env.PRO_PRICE || 29000),
    adminEmails: (process.env.ADMIN_EMAIL ?? '').split(','),
    contactUrl: process.env.PRO_CONTACT_URL ?? '',
  },
});

// Относительные пути сборки ломаются на адресе со слешем в конце.
app.get('/legal/', (c) => c.redirect('/legal', 301));
app.use('/assets/*', serveStatic({ root: STATIC_DIR, onFound: (_p, c) => c.header('cache-control', 'public, max-age=31536000, immutable') }));
app.use('*', serveStatic({ root: STATIC_DIR }));
// Одностраничное приложение: всё, что не файл и не API, отдаёт index.html.
app.get('*', serveStatic({ root: STATIC_DIR, path: 'index.html' }));

setInterval(() => purgeExpiredSessions(db).catch(() => {}), 6 * 3600_000).unref();

const server = serve({ fetch: app.fetch, port: PORT }, (info) => console.log(`CrewPay: http://localhost:${info.port}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    server.close();
    pool.end().finally(() => process.exit(0));
  });
