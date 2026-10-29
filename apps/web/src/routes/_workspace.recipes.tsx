import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_workspace/recipes')({ staticData: { view: 'recipes' } });
