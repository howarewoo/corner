import { bigint, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';

export const workspaceState = pgTable('workspace_state', {
  user_id: text().primaryKey(),
  data: text().notNull(),
  version: bigint({ mode: 'number' }).notNull().default(0),
  updated_at: text().notNull(),
});

export const mutationReceipts = pgTable('mutation_receipts', {
  user_id: text().notNull(),
  request_id: text().notNull(),
  payload_hash: text().notNull(),
  revision: bigint({ mode: 'number' }).notNull(),
  created_at: text().notNull(),
}, (table) => [
  primaryKey({ name: 'mutation_receipts_pkey', columns: [table.user_id, table.request_id] }),
  index('mutation_receipts_user_revision').on(table.user_id, table.revision),
]);

export const aiRuns = pgTable('corner_ai_runs', {
  id: text().primaryKey(),
  user_id: text().notNull(),
  request_id: text().notNull(),
  payload_hash: text().notNull(),
  kind: text().notNull(),
  status: text().notNull(),
  prompt: text().notNull(),
  reference_date: text().notNull(),
  base_revision: bigint({ mode: 'number' }).notNull(),
  result: text(),
  error: text(),
  error_code: text(),
  error_status: integer(),
  created_at: text().notNull(),
  updated_at: text().notNull(),
}, (table) => [
  unique('corner_ai_runs_user_id_kind_request_id_key').on(table.user_id, table.kind, table.request_id),
  index('corner_ai_runs_owner').on(table.user_id, table.created_at),
]);

export const subscriptionMeta = pgTable('corner_subscription_meta', {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const subscriptionAccounts = pgTable('corner_subscription_accounts', {
  user_id: text().primaryKey(),
  encrypted: text().notNull(),
  version: bigint({ mode: 'number' }).notNull().default(1),
  refresh_owner: text(),
  refresh_until: bigint({ mode: 'number' }).notNull().default(0),
});

export const subscriptionAttempts = pgTable('corner_subscription_attempts', {
  state_hash: text().primaryKey(),
  user_id: text().notNull(),
  session_hash: text().notNull(),
  encrypted: text().notNull(),
  expires_at: bigint({ mode: 'number' }).notNull(),
}, (table) => [index('corner_subscription_attempt_owner').on(table.user_id)]);

export const subscriptionGenerations = pgTable('corner_subscription_generations', {
  user_id: text().primaryKey(),
  generation: bigint({ mode: 'number' }).notNull(),
});
