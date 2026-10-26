import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { detailsSchema, recordPageSchema, type RecordDetails, type RecordPage, type RecordPageInput } from '@packages/api/workspace-data';
import type { Database, Transaction } from './queries.js';
import * as tables from './schema.js';
import { planRecord, recipeRecord, recipeRequestRecord } from './nutrition-records.js';
import { checkInRecord, reviewRecord, sessionRecords, templateRecord, trainingRequestRecord } from './training-records.js';
import { ApiError } from './http.js';

export async function consistentRead<T>(db: Database, userId: string,
  read: (connection: Transaction, revision: number) => Promise<T>): Promise<T> {
  return db.transaction(async (connection) => {
    const row = (await connection.select({ revision: tables.workspaceMetadata.revision }).from(tables.workspaceMetadata)
      .where(eq(tables.workspaceMetadata.user_id, userId)).limit(1))[0];
    return read(connection, row?.revision ?? 0);
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
export function checkCursor(cursor: { revision: number } | undefined, revision: number): void {
  if (cursor && cursor.revision !== revision)
    throw new ApiError(409, 'CURSOR_INVALIDATED', 'Your workspace changed. Refresh this list.');
}

const resourceTables = {
  recipes: tables.recipes, plan: tables.plannedMeals, sessions: tables.workoutSessions,
  templates: tables.workoutTemplates, checkIns: tables.checkIns, recipeRequests: tables.recipeRequests,
  trainingRequests: tables.trainingRequests, reviews: tables.trainingReviews,
  scheduledDates: tables.scheduledDates, groceryChecks: tables.groceryChecks,
};

export async function recordPage(db: Database, userId: string, raw: RecordPageInput): Promise<RecordPage> {
  const input = recordPageSchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => {
    checkCursor(input.cursor, revision);
    const table = resourceTables[input.resource];
    const filters = [sql`${table.user_id} = ${userId}`];
    if (input.from && input.through && 'date' in table)
      filters.push(sql`${table.date} between ${input.from} and ${input.through}`);
    if (input.status && 'status' in table) filters.push(sql`${table.status} = ${input.status}`);
    if (input.resource === 'templates' && input.search) {
      const pattern = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
      filters.push(sql`${tables.workoutTemplates.name} ilike ${pattern}`);
    }
    if (input.resource === 'recipes') {
      if (input.category) filters.push(sql`${tables.recipes.category} = ${input.category}`);
      if (input.favorite !== undefined) filters.push(sql`${tables.recipes.favorite} = ${input.favorite}`);
      if (input.search) {
        const pattern = '%' + input.search.replace(/[\\%_]/g, '\\$&') + '%';
        filters.push(sql`(${tables.recipes.name} ilike ${pattern} OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(${tables.recipes.content}->'tags') tag WHERE tag ilike ${pattern}
        ) OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(${tables.recipes.content}->'ingredients') ingredient
          WHERE ingredient->>'name' ilike ${pattern}
        ))`);
      }
    }
    const recent = input.order === 'recent' && (input.resource === 'sessions' || input.resource === 'checkIns');
    const reverseCollection = input.order === 'recent' &&
      ['recipeRequests', 'trainingRequests', 'reviews'].includes(input.resource);
    const identity = 'id' in table ? table.id : 'key' in table ? table.key : table.date;
    if (input.cursor) {
      if (recent) {
        if (!input.cursor.date || (input.resource === 'sessions' && !input.cursor.updatedAt))
          throw new ApiError(400, 'INVALID_CURSOR', 'Refresh this history list.');
        if (input.resource === 'sessions') filters.push(sql`(
          ${tables.workoutSessions.date} < ${input.cursor.date} OR
          (${tables.workoutSessions.date} = ${input.cursor.date} AND ${tables.workoutSessions.updated_at} < ${input.cursor.updatedAt}) OR
          (${tables.workoutSessions.date} = ${input.cursor.date} AND ${tables.workoutSessions.updated_at} = ${input.cursor.updatedAt} AND ${tables.workoutSessions.id} > ${input.cursor.id})
        )`);
        else filters.push(sql`(
          ${tables.checkIns.date} < ${input.cursor.date} OR
          (${tables.checkIns.date} = ${input.cursor.date} AND ${tables.checkIns.position} < ${input.cursor.position}) OR
          (${tables.checkIns.date} = ${input.cursor.date} AND ${tables.checkIns.position} = ${input.cursor.position} AND ${tables.checkIns.id} > ${input.cursor.id})
        )`);
      } else if (reverseCollection) filters.push(sql`(${table.position} < ${input.cursor.position} OR
        (${table.position} = ${input.cursor.position} AND ${identity} > ${input.cursor.id}))`);
      else filters.push(sql`(${table.position} > ${input.cursor.position} OR
        (${table.position} = ${input.cursor.position} AND ${identity} > ${input.cursor.id}))`);
    }
    const order = recent
      ? input.resource === 'sessions'
        ? sql`${tables.workoutSessions.date} DESC, ${tables.workoutSessions.updated_at} DESC, ${tables.workoutSessions.id} ASC`
        : sql`${tables.checkIns.date} DESC, ${tables.checkIns.position} DESC, ${tables.checkIns.id} ASC`
      : reverseCollection ? sql`${table.position} DESC, ${identity} ASC` : sql`${table.position} ASC, ${identity} ASC`;
    const result = await connection.execute(sql`SELECT * FROM ${table}
      WHERE ${sql.join(filters, sql` AND `)} ORDER BY ${order} LIMIT ${input.limit + 1}`);
    // Raw SQL has no column mapper; normalize the explicitly selected SQL scalar types.
    const rows: Array<Record<string, unknown> & { position: number }> = result.rows.map((row) => ({ ...row, position: Number(row.position),
      ...('created_at' in row ? { created_at: new Date(row.created_at as string).toISOString() } : {}),
      ...('updated_at' in row ? { updated_at: new Date(row.updated_at as string).toISOString() } : {}),
    }));
    const page = rows.slice(0, input.limit);
    let items: unknown[];
    switch (input.resource) {
      case 'recipes': items = page.map((row) => recipeRecord(row as typeof tables.recipes.$inferSelect)); break;
      case 'plan': items = page.map((row) => planRecord(row as typeof tables.plannedMeals.$inferSelect)); break;
      case 'sessions': items = await sessionRecords(connection, userId, page as Array<typeof tables.workoutSessions.$inferSelect>); break;
      case 'templates': items = page.map((row) => templateRecord(row as typeof tables.workoutTemplates.$inferSelect)); break;
      case 'checkIns': items = page.map((row) => checkInRecord(row as typeof tables.checkIns.$inferSelect)); break;
      case 'recipeRequests': items = page.map((row) => recipeRequestRecord(row as typeof tables.recipeRequests.$inferSelect)); break;
      case 'trainingRequests': items = page.map((row) => trainingRequestRecord(row as typeof tables.trainingRequests.$inferSelect)); break;
      case 'reviews': items = page.map((row) => reviewRecord(row as typeof tables.trainingReviews.$inferSelect)); break;
      case 'scheduledDates': items = page.map((row) => row.date); break;
      case 'groceryChecks': items = page.map((row) => ({ key: row.key, checked: row.checked })); break;
    }
    const logged = input.resource === 'plan' && page.length
      ? await connection.select({ id: tables.foodEntries.plan_entry_id }).from(tables.foodEntries)
        .where(and(eq(tables.foodEntries.user_id, userId), inArray(tables.foodEntries.plan_entry_id, page.map((row) => String(row.id))))) : [];
    const last = page.at(-1);
    return { resource: input.resource, revision, items, loggedPlanIds: logged.map((row) => row.id!),
      nextCursor: rows.length > input.limit && last ? {
        revision, position: last.position, id: String(last.id ?? last.key ?? last.date),
        ...(recent ? { date: String(last.date), ...(input.resource === 'sessions' ? { updatedAt: String(last.updated_at) } : {}) } : {}),
      } : null,
    } as RecordPage;
  });
}

export async function recordDetails(db: Database, userId: string, raw: z.input<typeof detailsSchema>): Promise<RecordDetails> {
  const input = detailsSchema.parse(raw);
  return consistentRead(db, userId, async (connection, revision) => ({ revision,
    recipes: input.recipeIds.length ? (await connection.select().from(tables.recipes)
      .where(and(eq(tables.recipes.user_id, userId), inArray(tables.recipes.id, input.recipeIds)))).map(recipeRecord) : [],
    plan: input.planIds.length ? (await connection.select().from(tables.plannedMeals)
      .where(and(eq(tables.plannedMeals.user_id, userId), inArray(tables.plannedMeals.id, input.planIds)))).map(planRecord) : [],
    templates: input.templateIds.length ? (await connection.select().from(tables.workoutTemplates)
      .where(and(eq(tables.workoutTemplates.user_id, userId), inArray(tables.workoutTemplates.id, input.templateIds)))).map(templateRecord) : [],
    sessions: input.sessionIds.length ? await sessionRecords(connection, userId,
      await connection.select().from(tables.workoutSessions)
        .where(and(eq(tables.workoutSessions.user_id, userId), inArray(tables.workoutSessions.id, input.sessionIds)))) : [],
  }));
}
