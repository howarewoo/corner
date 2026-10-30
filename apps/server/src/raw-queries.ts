import { createHash } from 'node:crypto';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { DateSchema } from '@packages/nutrition/schemas';
import type { Database, Transaction } from './queries.js';
import * as tables from './schema.js';
import { foodRecord } from './food-records.js';
import { planRecord, recipeRecord } from './nutrition-records.js';
import { checkInRecord, sessionRecords, templateRecord } from './training-records.js';
import { consistentRead, contentFilters } from './workspace-queries.js';
import { ApiError } from './http.js';

/**
 * MCP raw reads. Unlike the browser's bounded calendar/aggregate pages, these return whole stored
 * records over any date range, bounded by record count and by the encoded size of the complete
 * MCP tool result. Every page is read inside one owner-scoped repeatable-read snapshot and may be
 * pinned to a client-established workspace revision.
 */

/** Bytes reserved for the JSON-RPC wrapper (`jsonrpc`, `id`, `result`, `content` framing). */
export const RESULT_ENVELOPE_RESERVE = 512;
export const MIN_RESULT_BYTES = 16 * 1024;
export const DEFAULT_RESULT_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');

/**
 * Exact transmitted size of one tool result: the structured JSON, the same JSON repeated as an
 * escaped text content string, and a reserve for the JSON-RPC envelope.
 */
export function resultWireBytes(json: string): number {
  return byteLength(json) + byteLength(JSON.stringify(json)) + RESULT_ENVELOPE_RESERVE;
}

export function tooLarge(required: number): ApiError {
  return new ApiError(
    413,
    'RESPONSE_TOO_LARGE',
    required > MAX_RESULT_BYTES
      ? `This result needs ${required} bytes, above the ${MAX_RESULT_BYTES}-byte maximum, and cannot be returned whole. Request fewer records.`
      : `This result needs ${required} bytes. Retry with maxBytes of at least ${required} (maximum ${MAX_RESULT_BYTES}) or request fewer records.`,
  );
}

export function pinRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual)
    throw new ApiError(
      409,
      'REVISION_CHANGED',
      'Your workspace changed since the pinned revision. Restart this read without expectedRevision.',
    );
}

export const revisionInput = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

type Direction = 'asc' | 'desc';
type Key = readonly [column: string, direction: Direction];
const identity = ['id', 'asc'] as const;
const dated = ['date', 'asc'] as const;
const position = ['position', 'asc'] as const;
const byPosition = { collection: [position, identity] } as const;
const byDate = { collection: [dated, position, identity] } as const;

const specs = {
  sessions: {
    table: tables.workoutSessions,
    dated: true,
    orders: {
      ...byPosition,
      recent: [['date', 'desc'], ['updated_at', 'desc'], identity],
    },
  },
  templates: { table: tables.workoutTemplates, dated: false, orders: byPosition },
  recipes: { table: tables.recipes, dated: false, orders: byPosition },
  plan: { table: tables.plannedMeals, dated: true, orders: byDate },
  foodLogs: { table: tables.foodEntries, dated: true, orders: byDate },
  checkIns: {
    table: tables.checkIns,
    dated: true,
    orders: {
      ...byPosition,
      recent: [['date', 'desc'], ['position', 'desc'], identity],
    },
  },
  scheduledDates: { table: tables.scheduledDates, dated: true, orders: { collection: [dated] } },
  groceryChecks: {
    table: tables.groceryChecks,
    dated: false,
    orders: { collection: [['key', 'asc']] },
  },
} as const;

export type RawResource = keyof typeof specs;
export type RawFilters = {
  from?: string;
  through?: string;
  status?: string;
  search?: string;
  category?: string;
  favorite?: boolean;
  exerciseName?: string;
};
export type RawQuery = {
  resource: RawResource;
  order?: string;
  filters: RawFilters;
  limit: number;
  maxBytes: number;
  cursor?: string;
  expectedRevision?: number;
};

const cursorSchema = z
  .object({
    q: z.string(),
    r: revisionInput,
    k: z.array(z.union([z.string(), z.number()])).max(3),
  })
  .strict();

/** Binds a cursor to owner, resource, ordering and every effective filter, but not page size. */
function queryHash(ownerId: string, resource: string, order: string, filters: RawFilters): string {
  const effective = Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : 1));
  return createHash('sha256')
    .update(JSON.stringify([ownerId, resource, order, effective]))
    .digest('hex')
    .slice(0, 32);
}
function encodeCursor(q: string, r: number, k: Array<string | number>): string {
  return Buffer.from(JSON.stringify({ q, r, k }), 'utf8').toString('base64url');
}
function decodeCursor(cursor: string, q: string, keys: readonly Key[]) {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'Restart this list with a valid cursor.');
  }
  if (parsed.q !== q)
    throw new ApiError(
      400,
      'CURSOR_MISMATCH',
      'This cursor belongs to a different query. Reuse its tool, filters and order, or restart without a cursor.',
    );
  const valid = parsed.k.length === keys.length && keys.every(([column], index) => {
    const value = parsed.k[index];
    if (column === 'position') return revisionInput.safeParse(value).success;
    if (column === 'date') return DateSchema.safeParse(value).success;
    if (column === 'updated_at') return z.string().datetime().safeParse(value).success;
    return typeof value === 'string' && value.length > 0 && value.length <= 500;
  });
  if (!valid)
    throw new ApiError(400, 'INVALID_CURSOR', 'Restart this list with a valid cursor.');
  return parsed;
}

/** Strictly after the cursor row under mixed ascending/descending keys. */
function after(keys: readonly Key[], values: Array<string | number>): SQL {
  const branches = keys.map(([column, direction], index) => {
    const parts = keys
      .slice(0, index)
      .map(([prior], previous) => sql`${sql.identifier(prior)} = ${values[previous]}`);
    parts.push(
      direction === 'asc'
        ? sql`${sql.identifier(column)} > ${values[index]}`
        : sql`${sql.identifier(column)} < ${values[index]}`,
    );
    return sql`(${sql.join(parts, sql` AND `)})`;
  });
  return sql`(${sql.join(branches, sql` OR `)})`;
}

type Row = Record<string, unknown>;
async function assemble(
  connection: Transaction,
  userId: string,
  resource: RawResource,
  rows: Row[],
): Promise<unknown[]> {
  switch (resource) {
    case 'recipes':
      return rows.map((row) => recipeRecord(row as typeof tables.recipes.$inferSelect));
    case 'plan':
      return rows.map((row) => planRecord(row as typeof tables.plannedMeals.$inferSelect));
    case 'foodLogs':
      return rows.map((row) => foodRecord(row as typeof tables.foodEntries.$inferSelect));
    case 'sessions':
      return sessionRecords(
        connection,
        userId,
        rows as Array<typeof tables.workoutSessions.$inferSelect>,
      );
    case 'templates':
      return rows.map((row) => templateRecord(row as typeof tables.workoutTemplates.$inferSelect));
    case 'checkIns':
      return rows.map((row) => checkInRecord(row as typeof tables.checkIns.$inferSelect));
    case 'scheduledDates':
      return rows.map((row) => row.date);
    case 'groceryChecks':
      return rows.map((row) => ({ key: row.key, checked: row.checked }));
  }
}

const units = { bodyWeight: 'lb', waist: 'in', sleepHours: 'hours' };

/**
 * One whole-record page. The first page may carry `expectedRevision`; later pages' cursors carry
 * the revision they were read at. A page stops at `limit` records or when the next whole record
 * would exceed `maxBytes`; `nextCursor` is non-null exactly while records remain.
 */
export async function rawRecordPage(
  db: Database,
  userId: string,
  input: RawQuery,
): Promise<Record<string, unknown>> {
  const spec = specs[input.resource];
  const order = input.order ?? 'collection';
  const keys = (spec.orders as Record<string, readonly Key[]>)[order];
  if (!keys) throw new ApiError(400, 'INVALID_INPUT', 'This resource does not offer that order.');
  const q = queryHash(userId, input.resource, order, input.filters);
  const cursor = input.cursor ? decodeCursor(input.cursor, q, keys) : undefined;
  return consistentRead(db, userId, async (connection, revision) => {
    pinRevision(input.expectedRevision, revision);
    if (cursor && cursor.r !== revision)
      throw new ApiError(409, 'CURSOR_INVALIDATED', 'Your workspace changed. Restart this list.');
    const filters: SQL[] = [sql`${sql.identifier('user_id')} = ${userId}`];
    const { from, through } = input.filters;
    if (spec.dated && from) filters.push(sql`${sql.identifier('date')} >= ${from}`);
    if (spec.dated && through) filters.push(sql`${sql.identifier('date')} <= ${through}`);
    filters.push(...contentFilters({ ...input.filters, resource: input.resource }));
    if (input.filters.exerciseName) {
      filters.push(sql`EXISTS (
        SELECT 1 FROM workspace_workout_exercises e
        WHERE e.user_id = ${userId} AND e.session_id = ${tables.workoutSessions.id}
          AND lower(btrim(e.name)) = ${input.filters.exerciseName}
          AND EXISTS (SELECT 1 FROM workspace_workout_sets s
            WHERE s.user_id = e.user_id AND s.session_id = e.session_id
              AND s.exercise_id = e.id AND s.completed AND s.kind = 'working')
      )`);
    }
    if (cursor) filters.push(after(keys, cursor.k));
    const rows = (await connection
      .select()
      .from(spec.table as typeof tables.recipes)
      .where(and(...filters))
      .orderBy(
        ...keys.map(([column, direction]) =>
          direction === 'asc'
            ? sql`${sql.identifier(column)} ASC`
            : sql`${sql.identifier(column)} DESC`,
        ),
      )
      .limit(input.limit + 1)) as unknown as Row[];
    const page = rows.slice(0, input.limit);
    const items = await assemble(connection, userId, input.resource, page);
    const logged =
      input.resource === 'plan' && page.length
        ? new Set(
            (
              await connection
                .select({ id: tables.foodEntries.plan_entry_id })
                .from(tables.foodEntries)
                .where(
                  and(
                    eq(tables.foodEntries.user_id, userId),
                    inArray(
                      tables.foodEntries.plan_entry_id,
                      page.map((row) => String(row.id)),
                    ),
                  ),
                )
            ).map((row) => row.id),
          )
        : new Set<string | null>();
    const envelope = (count: number) => {
      const more = count < page.length || rows.length > input.limit;
      const last = page[count - 1];
      return {
        resource: input.resource,
        revision,
        ...(input.resource === 'plan'
          ? {
              loggedPlanIds: page
                .slice(0, count)
                .map((row) => String(row.id))
                .filter((id) => logged.has(id)),
            }
          : {}),
        ...(input.resource === 'checkIns' ? { units } : {}),
        items: [] as unknown[],
        nextCursor:
          more && last
            ? encodeCursor(
                q,
                revision,
                keys.map(([column]) => last[column] as string | number),
              )
            : null,
      };
    };
    // Whole records only. Wire bytes are additive over each record's JSON and its escaped copy in
    // the text content, so each prefix is measured exactly, including its own continuation cursor.
    let fit = 0;
    let required = 0;
    let structured = 0;
    let escaped = 0;
    for (let count = 0; count <= page.length; count++) {
      if (count > 0) {
        const json = JSON.stringify(items[count - 1]);
        structured += byteLength(json) + (count > 1 ? 1 : 0);
        escaped += byteLength(JSON.stringify(json)) - 2 + (count > 1 ? 1 : 0);
      }
      const head = JSON.stringify(envelope(count));
      const wire =
        byteLength(head) +
        structured +
        byteLength(JSON.stringify(head)) +
        escaped +
        RESULT_ENVELOPE_RESERVE;
      if (count === 1) required = wire;
      if (wire > input.maxBytes) break;
      fit = count;
    }
    if (page.length && !fit) throw tooLarge(required);
    return { ...envelope(fit), items: items.slice(0, fit) };
  });
}
