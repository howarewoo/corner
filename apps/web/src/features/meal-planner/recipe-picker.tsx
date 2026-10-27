import { useState } from 'react';
import type { Recipe, MealSlot } from '@packages/nutrition/types';
import { SLOTS } from '@packages/nutrition/types';
import { Search, UtensilsCrossed, CheckCircle2, Circle, Plus } from 'lucide-react';
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ToggleGroup,
  ToggleGroupItem,
} from '@packages/ui';
import { cap, newId } from '../workspace/utils';
import {
  Dialog,
  Field,
  MacroLine,
  ResourceStatus,
  ResourcePaging,
} from '../workspace/workspace-ui';
import { useRecordPage } from '../workspace/resources';
import { rpc, useResource } from '../../rpc';

export default function RecipePicker({
  recipes,
  date: initialDate,
  slot: initialSlot,
  initialRecipeId,
  busy,
  onClose,
  onAdd,
}: {
  recipes?: Recipe[];
  date: string;
  slot: MealSlot;
  initialRecipeId?: string;
  busy: boolean;
  onClose: () => void;
  onAdd: (recipe: Recipe, date: string, slot: MealSlot, servings: number, entryId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [entryId] = useState(newId);
  const [date, setDate] = useState(initialDate);
  const [slot, setSlot] = useState(initialSlot);
  const [servings, setServings] = useState(1);
  const [selected, setSelected] = useState<string | null>(initialRecipeId || null);
  const page = useRecordPage({ resource: 'recipes', search: query, limit: 30 }, !recipes);
  const detail = useResource(
    'details',
    { recipeIds: selected ? [selected] : [] },
    (signal) => rpc.workspace.details({ recipeIds: selected ? [selected] : [] }, { signal }),
    !recipes && Boolean(selected),
  );
  const recipe = (recipes ?? detail.data?.recipes ?? []).find((r) => r.id === selected);
  const filtered = [
    ...(recipes
      ? recipes.filter((r) =>
          `${r.name} ${r.tags.join(' ')} ${r.ingredients.map((item) => item.name).join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : (page.data?.items ?? [])),
  ].sort((a, b) => {
    const preferred =
      slot === 'breakfast' ? 'breakfast' : ['snack', 'fuel'].includes(slot) ? 'snack' : 'main';
    return Number(b.category === preferred) - Number(a.category === preferred);
  });
  return (
    <Dialog title="Add a meal to your plan" onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (recipe && !busy && (recipes || (!detail.isFetching && !detail.isError)))
            onAdd(recipe, date, slot, servings, entryId);
        }}
      >
        <div className="form-three">
          <Field label="Date">
            <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Meal">
            <NativeSelect value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)}>
              {SLOTS.map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {cap(s)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Servings">
            <Input
              type="number"
              required
              min={0.25}
              max={20}
              step={0.25}
              value={servings}
              onChange={(e) => setServings(Number(e.target.value))}
            />
          </Field>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <Search size={17} />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Find a recipe"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a recipe…"
          />
        </InputGroup>
        {!recipes && (!page.data || page.isError) && (
          <ResourceStatus error={page.error} loading={page.isPending} retry={page.reload} />
        )}
        {!recipes && selected && (!detail.data || detail.isError) && (
          <ResourceStatus
            error={detail.error}
            loading={detail.isPending}
            retry={() => void detail.refetch()}
          />
        )}
        {recipe && !filtered.some((item) => item.id === recipe.id) && (
          <p>Selected: {recipe.name}</p>
        )}
        <ToggleGroup
          className="recipe-picker-list"
          orientation="vertical"
          aria-label="Choose a recipe"
          value={selected ? [selected] : []}
          onValueChange={(values) => {
            if (values[0]) setSelected(String(values[0]));
          }}
        >
          {filtered.map((r) => (
            <ToggleGroupItem value={r.id} className="recipe-picker-item" type="button" key={r.id}>
              <span className={`meal-glyph ${r.category}`}>
                <UtensilsCrossed size={17} />
              </span>
              <span>
                <b>{r.name}</b>
                <MacroLine nutrition={r.nutrition} servings={servings} />
              </span>
              <span className="picker-check">
                {selected === r.id ? <CheckCircle2 size={18} /> : <Circle size={18} />}
              </span>
            </ToggleGroupItem>
          ))}
          {!filtered.length && (recipes || (page.data && !page.isError)) && (
            <p className="muted">No matching recipes. Try another search.</p>
          )}
        </ToggleGroup>
        {!recipes && <ResourcePaging {...page.paging} />}
        <div className="form-footer">
          <Button variant="outline" size="default" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="default"
            type="submit"
            disabled={busy || !recipe || (!recipes && (detail.isFetching || detail.isError))}
          >
            <Plus size={15} />
            Add to plan
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
