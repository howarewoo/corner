import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requestIdSchema, revisionSchema } from '@packages/api/schemas';
import { ImportSourceSchema } from '@packages/workspace/mutations';
import type { WorkspaceStore } from './store.js';
import type { DelegatedAccess } from './delegation.js';
import type { OriginalToolArguments } from './mcp-writes.js';
import { completedWorkoutSchema, MAX_IMPORT_RECORDS, workoutImportAdapter } from './additive-import.js';
import { ApiError } from './http.js';

export const workoutImportSchema = z.object({
  operationId: requestIdSchema,
  expectedRevision: revisionSchema,
  sourceNamespace: ImportSourceSchema.shape.sourceNamespace,
  records: z.array(z.object({
    sourceRecordId: ImportSourceSchema.shape.sourceRecordId,
    workout: completedWorkoutSchema,
  }).strict()).min(1).max(MAX_IMPORT_RECORDS),
}).strict();
export type WorkoutImportInput = z.infer<typeof workoutImportSchema>;

export function registerImports(server: McpServer, store: WorkspaceStore,
  access: DelegatedAccess, original: OriginalToolArguments): void {
  if (!access.scopes.includes('workouts:import')) return;
  server.registerTool('import_workouts', {
    description: 'Atomically import 1–100 completed workouts under a stable sourceNamespace and sourceRecordId. Supply all native WorkoutSession fields except createdAt/updatedAt (Corner generates persistence metadata). Keep native IDs stable across retries and reconnects. Requires operationId and expectedRevision. Identical normalized source content skips even after manual edits; changed sources or occupied native IDs conflict without overwriting. Unknown planning facts must be explicit nulls, never inferred. templateId is historical metadata only. Returns revision and created/skipped source and destination IDs, never existing records. Complete MCP JSON requests are limited to 2 MiB UTF-8; split larger batches explicitly. Does not grant record reads, updates or deletes.',
    inputSchema: workoutImportSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    try {
      const argumentsBeforeNormalization = original('import_workouts');
      const result = await store.delegatedImport(access, 'workouts:import', 'import_workouts',
        argumentsBeforeNormalization, input.operationId, input.expectedRevision, input.sourceNamespace,
        input.records.map(({ sourceRecordId, workout }) => ({ sourceRecordId, record: workout })),
        workoutImportAdapter);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      const result = error instanceof ApiError ? { code: error.code, error: error.message }
        : error instanceof z.ZodError ? { code: 'INVALID_INPUT', error: 'Check the import fields and try again.' }
          : { code: 'IMPORT_FAILED', error: 'This import could not be completed.' };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
    }
  });
}
