import { sql } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull().default(''),
  /** Pro действует до этого момента (пробный период или оплата); null — бесплатный план. */
  proUntil: timestamp('pro_until', { withTimezone: true }),
  /** trial — пробный период при регистрации, paid — выдано администратором после оплаты. */
  proSource: text('pro_source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Заявки на подписку: пользователь выбирает срок, администратор подтверждает после оплаты. */
export const proRequests = pgTable(
  'pro_requests',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    months: integer('months').notNull(),
    note: text('note').notNull().default(''),
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pro_requests_status_idx').on(t.status)],
);

/** Журнал выдачи подписок — кто, кому и на сколько. */
export const proGrants = pgTable('pro_grants', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  months: integer('months').notNull(),
  until: timestamp('until', { withTimezone: true }),
  grantedBy: text('granted_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Сессия хранится как sha256 от токена из cookie — утечка таблицы не даёт войти. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Профиль, личные оклады и настройки — одним документом. */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Сохранённые расчёты по месяцам. */
export const months = pgTable(
  'months',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    month: text('month').notNull(),
    state: jsonb('state').notNull(),
    totals: jsonb('totals').notNull(),
    payslipId: uuid('payslip_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.month] })],
);

/** Загруженные расчётные листки: исходный PDF и распознанные данные. */
export const payslips = pgTable(
  'payslips',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    month: text('month'),
    filename: text('filename').notNull(),
    file: bytea('file').notNull(),
    parsed: jsonb('parsed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('payslips_user_month_idx').on(t.userId, t.month)],
);

/** Идемпотентная миграция: выполняется при каждом запуске сервера. */
export const MIGRATION = `
create extension if not exists pgcrypto;
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  name text not null default '',
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions(user_id);
create table if not exists profiles (
  user_id uuid primary key references users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
create table if not exists months (
  user_id uuid not null references users(id) on delete cascade,
  month text not null,
  state jsonb not null,
  totals jsonb not null,
  payslip_id uuid,
  updated_at timestamptz not null default now(),
  primary key (user_id, month)
);
create table if not exists payslips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  month text,
  filename text not null,
  file bytea not null,
  parsed jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists payslips_user_month_idx on payslips(user_id, month);
alter table users add column if not exists pro_until timestamptz;
alter table users add column if not exists pro_source text;
create table if not exists pro_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  months integer not null,
  note text not null default '',
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create index if not exists pro_requests_status_idx on pro_requests(status);
create table if not exists pro_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  months integer not null,
  until timestamptz,
  granted_by text not null,
  created_at timestamptz not null default now()
);
`;
