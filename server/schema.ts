import { sql } from 'drizzle-orm';
import { bigint, customType, index, integer, jsonb, pgTable, primaryKey, serial, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  /** pending — ждёт решения администратора, active — доступ открыт, blocked — закрыт. */
  status: text('status').notNull().default('pending'),
  /** Когда пользователь принял условия и дал согласие на обработку данных. */
  termsAcceptedAt: timestamp('terms_accepted_at', { withTimezone: true }),
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

/** Заказ на оплату Pro через Payme или Click. Номер заказа — то, что видит платёжная система. */
export const orders = pgTable(
  'orders',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity({ startWith: 1001 }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    months: integer('months').notNull(),
    /** Сумма в сумах. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    provider: text('provider').notNull(),
    /** pending → paid | cancelled */
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => [index('orders_user_idx').on(t.userId)],
);

/** Транзакции Payme (Merchant API). Время — миллисекунды, как в протоколе. */
export const paymeTransactions = pgTable(
  'payme_transactions',
  {
    id: serial('id').primaryKey(),
    paymeId: text('payme_id').notNull().unique(),
    orderId: integer('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    /** В тийинах. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    state: integer('state').notNull(),
    paymeTime: bigint('payme_time', { mode: 'number' }).notNull(),
    createTime: bigint('create_time', { mode: 'number' }).notNull(),
    performTime: bigint('perform_time', { mode: 'number' }).notNull().default(0),
    cancelTime: bigint('cancel_time', { mode: 'number' }).notNull().default(0),
    reason: integer('reason'),
  },
  (t) => [index('payme_tx_order_idx').on(t.orderId), index('payme_tx_time_idx').on(t.paymeTime)],
);

/** Транзакции Click (SHOP API: Prepare → Complete). */
export const clickTransactions = pgTable('click_transactions', {
  id: serial('id').primaryKey(),
  clickTransId: bigint('click_trans_id', { mode: 'number' }).notNull().unique(),
  orderId: integer('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  amount: text('amount').notNull(),
  /** prepared → completed | cancelled */
  state: text('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Настройки, которые меняются во время работы (например, ключ кассы Payme после ChangePassword). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
-- Уже зарегистрированные до появления одобрения сохраняют доступ; новые ждут администратора.
alter table users add column if not exists status text not null default 'active';
alter table users alter column status set default 'pending';
alter table users add column if not exists terms_accepted_at timestamptz;
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
create table if not exists orders (
  id integer generated by default as identity (start with 1001) primary key,
  user_id uuid not null references users(id) on delete cascade,
  months integer not null,
  amount bigint not null,
  provider text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists orders_user_idx on orders(user_id);
create table if not exists payme_transactions (
  id serial primary key,
  payme_id text not null unique,
  order_id integer not null references orders(id) on delete cascade,
  amount bigint not null,
  state integer not null,
  payme_time bigint not null,
  create_time bigint not null,
  perform_time bigint not null default 0,
  cancel_time bigint not null default 0,
  reason integer
);
create index if not exists payme_tx_order_idx on payme_transactions(order_id);
create index if not exists payme_tx_time_idx on payme_transactions(payme_time);
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
create table if not exists click_transactions (
  id serial primary key,
  click_trans_id bigint not null unique,
  order_id integer not null references orders(id) on delete cascade,
  amount text not null,
  state text not null,
  created_at timestamptz not null default now()
);
`;
