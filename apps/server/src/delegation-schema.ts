import { index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { AdapterPayload } from 'oidc-provider';
import type { JWK } from 'jose';

/** Maintained issuer models only; these rows cannot establish a managed account. */
export const delegationObjects = pgTable(
  'delegation_objects',
  {
    model: text('model').notNull(),
    id: text('id').notNull(),
    payload: jsonb('payload').$type<AdapterPayload>().notNull(),
    grantId: text('grant_id'),
    ownerId: text('owner_id'),
    clientId: text('client_id'),
    managedSessionId: text('managed_session_id'),
    managedSessionExpiresAt: timestamp('managed_session_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.id] }),
    index('delegation_objects_grant_idx').on(table.grantId),
    index('delegation_objects_owner_model_idx').on(table.ownerId, table.model),
    index('delegation_objects_client_idx').on(table.clientId),
  ],
);

/** Insert-once delegation keys, retained in database backups; never workspace exports. */
export const delegationIssuer = pgTable('delegation_issuer', {
  origin: text('origin').primaryKey(),
  cookieKey: text('cookie_key').notNull(),
  signingJwk: jsonb('signing_jwk').$type<JWK>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
