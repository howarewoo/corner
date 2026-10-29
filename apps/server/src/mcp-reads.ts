import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { DateSchema } from '@packages/nutrition/schemas';
import { detailsSchema, exerciseHistorySchema } from '@packages/api/workspace-data';
import type { DelegatedAccess } from './delegation.js';
import type { WorkspaceStore } from './store.js';
import { consistentRead, recordDetails } from './workspace-queries.js';
import { workoutSessions } from './schema.js';
import {
  DEFAULT_RESULT_BYTES,
  MAX_RESULT_BYTES,
  MIN_RESULT_BYTES,
  pinRevision,
  rawRecordPage,
  resultWireBytes,
  revisionInput,
  tooLarge,
  type RawFilters,
  type RawResource,
} from './raw-queries.js';
import { ApiError } from './http.js';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
// Client-visible read failures. Messages are authored where thrown and never include record data.
const readErrors: Record<string, true> = {
  CURSOR_INVALIDATED: true,
  INVALID_CURSOR: true,
  CURSOR_MISMATCH: true,
  REVISION_CHANGED: true,
  RESPONSE_TOO_LARGE: true,
};

const expectedRevision = revisionInput
  .optional()
  .describe(
    'Pin this read to a workspace revision returned by an earlier read. Pass the same value to every domain read and page of one analysis; any intervening workspace change fails with REVISION_CHANGED instead of mixing revisions. Omit on the first read to learn the current revision.',
  );
const paging = {
  expectedRevision,
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe(
      'Maximum whole records per page; a page may hold fewer when maxBytes is reached first.',
    ),
  maxBytes: z
    .number()
    .int()
    .min(MIN_RESULT_BYTES)
    .max(MAX_RESULT_BYTES)
    .default(DEFAULT_RESULT_BYTES)
    .describe(
      'Upper bound on the transmitted result: the structured JSON, its duplicate text content and a JSON-RPC envelope reserve. Records are never truncated; a page ends early with nextCursor.',
    ),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      'Opaque nextCursor from the previous page of this same tool, filters and order. Rejected if the query or workspace revision changed.',
    ),
};
const dates = {
  from: DateSchema.optional().describe('First owner-local calendar date, YYYY-MM-DD, inclusive.'),
  through: DateSchema.optional().describe('Last owner-local calendar date, YYYY-MM-DD, inclusive.'),
};
const detailOrder = z.enum(['collection', 'recent']).default('collection').describe(
  'collection is stable insertion order; recent is newest date first. Part of the cursor binding.',
);
const statuses = z.enum(['planned', 'in_progress', 'completed', 'skipped']);

type PageArguments = RawFilters & {
  order?: string;
  limit: number;
  maxBytes: number;
  cursor?: string;
  expectedRevision?: number;
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
          const text = JSON.stringify(result);
          const wire = resultWireBytes(text);
          if (wire > MAX_RESULT_BYTES) throw tooLarge(wire);
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: result,
          };
        } catch (error) {
          if (error instanceof z.ZodError)
            return failure('INVALID_INPUT', 'Check the fields and try again.');
          if (error instanceof ApiError && Object.hasOwn(readErrors, error.code))
            return failure(error.code, error.message);
          return failure('READ_FAILED', 'This read could not be completed. Please try again.');
        }
      },
    );
  }

  function list<S extends z.ZodRawShape>(
    name: string,
    scope: string,
    resource: RawResource,
    shape: S,
    description: string,
  ): void {
    const schema = z
      .object({ ...paging, ...shape })
      .strict()
      .refine(
        (input) => {
          const { from, through } = input as PageArguments;
          return !from || !through || from <= through;
        },
        'from must not be after through.',
      );
    register(name, scope, description, schema, (input) => {
      const { expectedRevision, limit, maxBytes, cursor, order, ...filters } =
        input as PageArguments;
      return rawRecordPage(store.db, ownerId, {
        resource,
        order,
        filters,
        limit,
        maxBytes,
        cursor,
        expectedRevision,
      });
    });
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
      `Read selected ${resource} by ID, including their stored versions where available. Missing IDs are omitted. Oversized results fail with RESPONSE_TOO_LARGE rather than truncating.`,
      z.object({ ids: detailsSchema.shape[field], expectedRevision }).strict(),
      async ({ ids, expectedRevision }) => {
        const result = await recordDetails(store.db, ownerId, { [field]: ids });
        pinRevision(expectedRevision, result.revision);
        return { revision: result.revision, [resource]: result[resource] };
      },
    );
  }
  const complete =
    'Whole stored records, never truncated. Dates are owner-local calendar dates (YYYY-MM-DD, inclusive filters) with no range limit. Returns { resource, revision, items, nextCursor }: follow nextCursor explicitly until it is null; a null cursor on a page is the terminal page. Any workspace write invalidates cursors and pinned revisions.';

  list(
    'list_workouts',
    'workouts:read',
    'sessions',
    { ...dates, status: statuses.optional(), order: detailOrder },
    `Read workouts, planned and recorded, with complete exercises, sets, notes, units and versions in each record, so no per-workout detail call is needed. Optional status filter. ${complete}`,
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
    'Read one bounded page of completed sessions with recorded working sets for an exercise name. Returns stored workout versions and a continuation cursor. Oversized pages fail with RESPONSE_TOO_LARGE rather than truncating.',
    z.object({ ...paging, name: exerciseHistorySchema.shape.name,
      limit: exerciseHistorySchema.shape.limit }).strict(),
    async ({ name, ...input }) => {
      const result = await rawRecordPage(store.db, ownerId, {
        ...input,
        resource: 'sessions',
        order: 'recent',
        filters: { status: 'completed', exerciseName: name.trim().toLowerCase() },
      });
      return { revision: result.revision, sessions: result.items, nextCursor: result.nextCursor };
    },
  );
  list(
    'list_routines',
    'routines:read',
    'templates',
    { search: z.string().trim().max(200).optional() },
    `Read routine templates, optionally matching a name. ${complete}`,
  );
  details('get_routines', 'routines:read', 'templateIds', 'templates');
  list(
    'list_meal_plans',
    'meal-plans:read',
    'plan',
    dates,
    `Read dated meal plans in date order. loggedPlanIds on each page distinguish recorded meals from plans. ${complete}`,
  );
  details('get_meal_plans', 'meal-plans:read', 'planIds', 'plan');
  list(
    'list_food_logs',
    'food-logs:read',
    'foodLogs',
    dates,
    `Read recorded food logs in date order with their stored nutrition snapshots. Raw records only: no totals or other aggregates are computed. ${complete}`,
  );
  list(
    'list_recipes',
    'recipes:read',
    'recipes',
    {
      search: z.string().trim().max(200).optional(),
      category: z.enum(['breakfast', 'main', 'snack']).optional(),
      favorite: z.boolean().optional(),
    },
    `Read recipes, optionally filtered by search, category or favorite. ${complete}`,
  );
  details('get_recipes', 'recipes:read', 'recipeIds', 'recipes');
  list(
    'list_check_ins',
    'check-ins:read',
    'checkIns',
    { ...dates, order: detailOrder },
    `Read body and recovery check-ins (weight, waist, sleep, energy, soreness, boxing quality, notes). Units are native and stated in the result: body weight in pounds (lb), waist in inches (in), sleep in hours; ratings are 1-5; null means not recorded. ${complete}`,
  );
  list(
    'list_scheduled_dates',
    'scheduled-dates:read',
    'scheduledDates',
    dates,
    `Read dates on which the owner scheduled training, as YYYY-MM-DD strings in date order. ${complete}`,
  );
  list(
    'list_grocery_checks',
    'grocery-checks:read',
    'groceryChecks',
    {},
    `Read grocery check marks as { key, checked }, where key is weekStart|ingredient|unit. ${complete}`,
  );
  register(
    'get_settings',
    'settings:read',
    'Read the owner’s approved workspace configuration only: display name, timezone (IANA), nutrition targets for training and rest days (calories, protein, carbs, fat), weekly workout schedule (weekday 0-6 to label), and the training/diet profile with goals, preferences, equipment, constraints and default workout unit. Never account, credential or connection data.',
    z.object({ expectedRevision }).strict(),
    async ({ expectedRevision }) => {
      const { settings, revision } = await store.bootstrap(ownerId);
      pinRevision(expectedRevision, revision);
      return { revision, settings };
    },
  );
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
