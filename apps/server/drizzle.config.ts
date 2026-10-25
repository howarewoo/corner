import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['public'],
  tablesFilter: [
    'workspace_state',
    'mutation_receipts',
    'corner_ai_runs',
    'corner_subscription_meta',
    'corner_subscription_accounts',
    'corner_subscription_attempts',
    'corner_subscription_generations',
  ],
});
