import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type DB = NodePgDatabase<typeof schema>;

/** Облачные Postgres требуют TLS; локальный и база в соседнем контейнере (имя без точки: crewpay-db) — нет. */
export function needsTls(url: string): boolean {
  if (/sslmode=disable/.test(url)) return false;
  const host = new URL(url).hostname;
  return host.includes('.') && host !== '127.0.0.1' && host !== 'localhost';
}

export function connect(url: string): { db: DB; pool: pg.Pool } {
  const pool = new pg.Pool({
    connectionString: url,
    ssl: needsTls(url) ? true : undefined,
    // Neon добавляет channel_binding=require — включаем SCRAM-SHA-256-PLUS.
    enableChannelBinding: /channel_binding=require/.test(url),
    max: 10,
  });
  return { db: drizzle(pool, { schema }), pool };
}

export async function migrate(pool: pg.Pool) {
  await pool.query(schema.MIGRATION);
}
