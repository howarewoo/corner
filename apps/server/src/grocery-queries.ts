import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { groceriesSchema, type GroceryWindow } from '@packages/api/workspace-data';
import { weekDates } from '@packages/nutrition/dates';
import type { Database } from './queries.js';
import { checkCursor, consistentRead } from './workspace-queries.js';

/** Aggregate the whole week in SQL; paginate groups, never truncate source meals. */
export async function groceries(
  db: Database,
  userId: string,
  raw: z.input<typeof groceriesSchema>,
): Promise<GroceryWindow> {
  const input = groceriesSchema.parse(raw);
  const dates = weekDates(input.weekStart);
  return consistentRead(db, userId, async (connection, revision) => {
    checkCursor(input.cursor, revision);
    const after = input.cursor ? sql`AND g.key COLLATE "C" > ${input.cursor.key}` : sql``;
    const result = await connection.execute(sql`
      WITH ingredients AS (
        SELECT p.position, i.ordinality, i.value->>'name' AS name,
          coalesce(i.value->>'shoppingUnit', i.value->>'unit') AS unit,
          lower(btrim(i.value->>'name')) || '|' || lower(btrim(coalesce(i.value->>'shoppingUnit', i.value->>'unit'))) AS key,
          coalesce((i.value->>'shoppingQuantity')::float8, (i.value->>'quantity')::float8) * p.servings AS quantity,
          i.value->>'aisle' AS aisle, i.value->>'note' AS note
        FROM workspace_planned_meals p
        JOIN workspace_recipes r ON r.user_id = p.user_id AND r.id = p.recipe_id
        CROSS JOIN LATERAL jsonb_array_elements(r.content->'ingredients') WITH ORDINALITY i(value, ordinality)
        WHERE p.user_id = ${userId} AND p.date BETWEEN ${dates[0]} AND ${dates[6]}
          AND NOT coalesce((i.value->>'optional')::boolean, false)
          AND lower(btrim(i.value->>'name')) <> 'water'
      ), positive AS (SELECT * FROM ingredients WHERE quantity > 0),
      first_notes AS (
        SELECT DISTINCT ON (key, note) key, note, position, ordinality
        FROM positive WHERE note IS NOT NULL AND note <> '' ORDER BY key, note, position, ordinality
      ), notes AS (
        SELECT key, jsonb_agg(note ORDER BY position, ordinality) AS notes FROM first_notes GROUP BY key
      ), grouped AS (
        SELECT key, (array_agg(name ORDER BY position, ordinality))[1] AS name,
          (array_agg(unit ORDER BY position, ordinality))[1] AS unit,
          (array_agg(aisle ORDER BY position, ordinality))[1] AS aisle,
          floor(sum(quantity) * 100 + 0.5) / 100 AS quantity
        FROM positive GROUP BY key
      ) SELECT g.*, coalesce(n.notes, '[]'::jsonb) AS notes, c.checked
        FROM grouped g LEFT JOIN notes n USING (key)
        LEFT JOIN workspace_grocery_checks c ON c.user_id = ${userId} AND c.key = ${input.weekStart} || '|' || g.key
        WHERE true ${after} ORDER BY g.key COLLATE "C" ASC LIMIT ${input.limit + 1}`);
    const page = result.rows.slice(0, input.limit);
    const items = page.map((row) => ({
      key: String(row.key),
      name: String(row.name),
      quantity: Number(row.quantity),
      unit: String(row.unit),
      aisle: String(row.aisle),
      notes: row.notes as string[],
    }));
    const checks: Record<string, boolean> = {};
    for (const row of page)
      if (row.checked !== null)
        checks[`${input.weekStart}|${String(row.key)}`] = Boolean(row.checked);
    return {
      revision,
      items,
      checks,
      nextCursor:
        result.rows.length > input.limit ? { revision, key: items[items.length - 1].key } : null,
    };
  });
}
