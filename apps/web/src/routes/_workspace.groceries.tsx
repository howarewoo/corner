import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/groceries')({
  staticData: { view: 'groceries' },
});
