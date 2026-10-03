import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Regulation } from '../src/calc/types';
import { createApp } from './app';
import { purgeExpiredSessions } from './auth';
import { connect, migrate } from './db';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL не задан');
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? fileURLToPath(new URL('../dist/', import.meta.url));
// Справочник можно вынести в том (volume) и править без пересборки.
const REGULATION_PATH = process.env.REGULATION_PATH ?? `${STATIC_DIR}regulation.json`;

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
});

app.get('/regulation.json', async (c) => {
  c.header('cache-control', 'no-cache');
  return c.json(await regulation());
});
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
