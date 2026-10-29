import { createFileRoute } from '@tanstack/react-router';

// Account/OAuth entrypoints validate raw URLs in app.tsx, not normalized leaf matches.
export const Route = createFileRoute('/_workspace/$')({});
