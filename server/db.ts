import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type DB = NodePgDatabase<typeof schema>;

export function connect(url: string): { db: DB; pool: pg.Pool } {
  // Neon и другие облачные Postgres требуют TLS; локальный — нет.
  const local = /@(localhost|127\.0\.0\.1|db|postgres)(:\d+)?\//.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local || /sslmode=disable/.test(url) ? undefined : true,
    max: 10,
  });
  return { db: drizzle(pool, { schema }), pool };
}

export async function migrate(pool: pg.Pool) {
  await pool.query(schema.MIGRATION);
}
