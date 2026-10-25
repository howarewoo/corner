import type { StoryObj } from '@storybook/react-vite';
import { WorkspaceHeader } from '@packages/ui';
import { catalog } from '../catalog';
import { Specimen } from '../specimens';

export function CatalogStory({ id }: { id: string }) {
  const item = catalog.find((entry) => entry.id === id)!;
  return (
    <div className="catalog-story">
      <WorkspaceHeader title={item.label} description={item.description} />
      <p className="source-line">{item.group} · {item.importPath}</p>
      <Specimen key={id} id={id} />
    </div>
  );
}

export function catalogStory(id: string): StoryObj<typeof CatalogStory> {
  const item = catalog.find((entry) => entry.id === id)!;
  return { name: item.label, args: { id } };
}
