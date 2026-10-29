import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { foodWindowSchema } from '@packages/api/schemas';
import {
  detailsSchema,
  exerciseHistorySchema,
  recordPageSchema,
} from '@packages/api/workspace-data';
import type { DelegatedAccess } from './delegation.js';
import type { WorkspaceStore } from './store.js';
import { consistentRead, recordDetails, recordPage } from './workspace-queries.js';
import { workoutSessions } from './schema.js';
import { exerciseHistoryPage } from './training-queries.js';
import { ApiError } from './http.js';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createReadMcpServer(store: WorkspaceStore, access: DelegatedAccess): McpServer {
  const server = new McpServer({ name: 'corner', version: '1.0.0' });
  // Identity is captured from the validated bearer, never from tool arguments.
  const ownerId = access.ownerId;
  function register<S extends z.ZodRawShape>(
    name: string,
    scope: string | string[],
    description: string,
    inputSchema: z.ZodObject<S, z.core.$strict>,
    read: (input: z.output<z.ZodObject<S, z.core.$strict>>) => Promise<Record<string, unknown>>,
  ): void {
    const permitted = () =>
      (Array.isArray(scope) ? scope : [scope]).some((value) => access.scopes.includes(value));
    if (!permitted()) return;
    server.registerTool<z.ZodRawShape, z.ZodObject<S, z.core.$strict>>(
      name,
      { description, inputSchema, annotations },
      async (input) => {
        if (!permitted())
          return failure('INSUFFICIENT_SCOPE', 'This connection does not permit this read.');
        try {
          const result = await read(input);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          if (error instanceof z.ZodError)
            return failure('INVALID_INPUT', 'Check the fields and try again.');
          if (error instanceof ApiError && error.code === 'CURSOR_INVALIDATED')
            return failure('CURSOR_INVALIDATED', 'Your workspace changed. Restart this list.');
          if (error instanceof ApiError && error.code === 'INVALID_CURSOR')
            return failure('INVALID_CURSOR', 'Restart this list with a valid cursor.');
          return failure('READ_FAILED', 'This read could not be completed. Please try again.');
        }
      },
    );
  }

  const page = recordPageSchema.shape;
  const common = { limit: page.limit, cursor: page.cursor };
  const calendar = { from: page.from, through: page.through };
  function list<S extends z.ZodRawShape>(
    name: string,
    scope: string,
    resource: 'sessions' | 'templates' | 'plan' | 'recipes',
    shape: S,
    description: string,
  ): void {
    const schema = z
      .object(shape)
      .strict()
      .superRefine((input, context) => {
        const parsed = recordPageSchema.safeParse({ ...input, resource });
        if (!parsed.success)
          for (const issue of parsed.error.issues) context.addIssue({ ...issue });
      });
    register(name, scope, description, schema, (input) =>
      recordPage(store.db, ownerId, { ...input, resource }),
    );
  }
  function details(
    name: string,
    scope: string,
    field: 'sessionIds' | 'templateIds' | 'planIds' | 'recipeIds',
    resource: 'sessions' | 'templates' | 'plan' | 'recipes',
  ): void {
    register(
      name,
      scope,
      `Read selected ${resource} by ID, including their stored versions where available. Missing IDs are omitted.`,
      z.object({ ids: detailsSchema.shape[field] }).strict(),
      async ({ ids }) => {
        const result = await recordDetails(store.db, ownerId, { [field]: ids });
        return { revision: result.revision, [resource]: result[resource] };
      },
    );
  }

  list(
    'list_workouts',
    'workouts:read',
    'sessions',
    { ...common, ...calendar, status: page.status, order: page.order },
    'Read one bounded workout page. Includes planned and recorded sessions; status optionally filters them. Recent order provides workout history. Follow nextCursor explicitly; workspace changes invalidate cursors.',
  );
  details('get_workouts', 'workouts:read', 'sessionIds', 'sessions');
  register(
    'get_workout_versions',
    ['workout-plans:write', 'workout-history:write'],
    'Read concurrency metadata only for addressed workout IDs: workspace revision and stored updatedAt tokens. Missing IDs are omitted. No workout contents are returned; use before updates or after conflicts. An empty ID list returns the current revision.',
    z.object({ ids: detailsSchema.shape.sessionIds }).strict(),
    ({ ids }) =>
      consistentRead(store.db, ownerId, async (connection, revision) => ({
        revision,
        sessions: ids.length
          ? await connection
              .select({ id: workoutSessions.id, updatedAt: workoutSessions.updated_at })
              .from(workoutSessions)
              .where(and(eq(workoutSessions.user_id, ownerId), inArray(workoutSessions.id, ids)))
          : [],
      })),
  );
  register(
    'exercise_history',
    'workouts:read',
    'Read one bounded page of completed sessions with recorded working sets for an exercise name. Returns stored workout versions and a continuation cursor.',
    exerciseHistorySchema,
    (input) => exerciseHistoryPage(store.db, ownerId, input),
  );
  list(
    'list_routines',
    'routines:read',
    'templates',
    { ...common, search: page.search },
    'Read one bounded page of routine templates, optionally matching a name.',
  );
  details('get_routines', 'routines:read', 'templateIds', 'templates');
  list(
    'list_meal_plans',
    'meal-plans:read',
    'plan',
    { ...common, from: page.from.unwrap(), through: page.through.unwrap() },
    'Read one meal-plan page within a required range of at most 93 days. Logged plan IDs distinguish recorded meals from plans.',
  );
  details('get_meal_plans', 'meal-plans:read', 'planIds', 'plan');
  register(
    'list_food_logs',
    'food-logs:read',
    'Read one recorded-food page within at most 93 days, with bounded-window totals and a continuation cursor. These are recorded logs, not meal plans.',
    foodWindowSchema,
    (input) => store.foodWindow(ownerId, input),
  );
  list(
    'list_recipes',
    'recipes:read',
    'recipes',
    { ...common, search: page.search, category: page.category, favorite: page.favorite },
    'Read one bounded recipe page, optionally filtered by search, category or favorite.',
  );
  details('get_recipes', 'recipes:read', 'recipeIds', 'recipes');
  return server;
}

function failure(code: string, error: string) {
  const result = { code, error };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}
