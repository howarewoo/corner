'use client';

import { useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { Check, Loader2 } from 'lucide-react';
import type { Ingredient, Recipe, RecipeCategory } from '@packages/nutrition/types';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
} from '@packages/ui';
import { newId, zero } from '../workspace/utils';
import { Dialog, Field, MacroFields } from '../workspace/workspace-ui';

function parseIngredients(text: string, recipe?: Recipe): Ingredient[] | string {
  const parsed: Ingredient[] = [];
  for (const line of text.split('\n').filter((s) => s.trim())) {
    const parts = line.split('|').map((s) => s.trim());
    if (
      parts.length < 3 ||
      !parts[0] ||
      !Number.isFinite(Number(parts[0])) ||
      Number(parts[0]) <= 0 ||
      !parts[1] ||
      !parts[2]
    ) {
      return 'Please enter each ingredient as quantity | unit | ingredient | aisle. Example: 150 | g | chicken breast, raw | Meat & seafood';
    }
    const existing = recipe?.ingredients.find((i) => i.name === parts[2]);
    parsed.push({
      name: parts[2],
      quantity: Number(parts[0]),
      unit: parts[1],
      aisle: parts[3] || 'Other',
      note: parts[4] || undefined,
      ...(existing && existing.quantity === Number(parts[0]) && existing.unit === parts[1]
        ? {
            shoppingQuantity: existing.shoppingQuantity,
            shoppingUnit: existing.shoppingUnit,
            optional: existing.optional,
            display: existing.display,
          }
        : {}),
    });
  }
  return parsed;
}

export default function RecipeForm({
  recipe,
  busy,
  onClose,
  onSave,
}: {
  recipe?: Recipe;
  busy: boolean;
  onClose: () => void;
  onSave: (recipe: Recipe) => Promise<void>;
}) {
  const [recipeId] = useState(() => recipe?.id || newId());
  const [createdAt] = useState(() => recipe?.createdAt || new Date().toISOString());
  const [defaultValues] = useState(() => ({
    name: recipe?.name || '',
    description: recipe?.description || '',
    category: recipe?.category || ('main' as RecipeCategory),
    prep: recipe?.prepMinutes ?? 10,
    cook: recipe?.cookMinutes ?? 15,
    nutrition: recipe?.nutrition || { ...zero },
    ingredients:
      recipe?.ingredients
        .map(
          (i) =>
            `${i.quantity} | ${i.unit} | ${i.name} | ${i.aisle}${i.note ? ` | ${i.note}` : ''}`,
        )
        .join('\n') || '',
    steps: recipe?.steps.join('\n') || '',
    storage: recipe?.storage || '',
    variation: recipe?.variation || '',
  }));
  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => {
        const parsed = parseIngredients(value.ingredients, recipe);
        if (typeof parsed === 'string') return parsed;
        if (!parsed.length || !value.steps.trim())
          return 'Add at least one ingredient and one cooking step.';
        return undefined;
      },
    },
    onSubmit: async ({ value }): Promise<void> => {
      if (busy) return;
      try {
        await submit(value);
      } catch (failure) {
        form.setErrorMap({
          onSubmit: failure instanceof Error ? failure.message : 'Your recipe could not be saved.',
        });
      }
    },
  });
  const name = useStore(form.store, (state) => state.values.name);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const formError = useStore(form.store, (state) => state.errorMap.onSubmit);
  async function submit({
    name,
    description,
    category,
    prep,
    cook,
    nutrition,
    ingredients,
    steps,
    storage,
    variation,
  }: typeof defaultValues) {
    const parsed = parseIngredients(ingredients, recipe);
    if (typeof parsed === 'string') return;
    await onSave({
      ...recipe,
      id: recipeId,
      name: name.trim(),
      description: description.trim(),
      category,
      prepMinutes: prep,
      cookMinutes: cook,
      nutrition,
      ingredients: parsed,
      steps: steps
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      storage: storage.trim(),
      variation: variation.trim(),
      tags: recipe?.tags || ['My recipe'],
      color: recipe?.color || '#e8eee1',
      source: recipe?.source || 'manual',
      favorite: recipe?.favorite || false,
      createdAt,
      nutritionNote:
        recipe?.nutritionNote ||
        'Nutrition entered manually. Check package labels and portions for the best estimate.',
    });
  }
  return (
    <Dialog title={recipe ? 'Edit recipe' : 'Add a new recipe'} onClose={onClose} wide>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !form.state.isSubmitting) void form.handleSubmit();
        }}
      >
        <Field label="Recipe name">
          <form.Field name="name">
            {(field) => (
              <Input
                required
                maxLength={160}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="Give this one a name"
              />
            )}
          </form.Field>
        </Field>
        <Field label="A little about it">
          <form.Field name="description">
            {(field) => (
              <Input
                maxLength={500}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="What makes this a good addition to your rotation?"
              />
            )}
          </form.Field>
        </Field>
        <div className="form-three">
          <Field label="Category">
            <form.Field name="category">
              {(field) => (
                <NativeSelect
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as RecipeCategory)}
                >
                  <NativeSelectOption value="breakfast">Breakfast</NativeSelectOption>
                  <NativeSelectOption value="main">Main meal</NativeSelectOption>
                  <NativeSelectOption value="snack">Snack & fuel</NativeSelectOption>
                </NativeSelect>
              )}
            </form.Field>
          </Field>
          <Field label="Prep time (min)">
            <form.Field name="prep">
              {(field) => (
                <Input
                  required
                  type="number"
                  min={0}
                  max={1440}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(Number(e.target.value))}
                />
              )}
            </form.Field>
          </Field>
          <Field label="Cook time (min)">
            <form.Field name="cook">
              {(field) => (
                <Input
                  required
                  type="number"
                  min={0}
                  max={1440}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(Number(e.target.value))}
                />
              )}
            </form.Field>
          </Field>
        </div>
        <div className="form-section-label">NUTRITION & INGREDIENTS FOR ONE SERVING</div>
        <form.Field name="nutrition">
          {(field) => (
            <MacroFields
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
        <Field
          label="Ingredients"
          hint="One per line: quantity | unit | ingredient | aisle | optional note. Use raw meat and dry grain weights for easy shopping."
        >
          <form.Field name="ingredients">
            {(field) => (
              <Textarea
                required
                rows={5}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={
                  '150 | g | Chicken breast, raw | Meat & seafood\n75 | g | Rice, dry | Pantry\n1 | tbsp | Olive oil | Pantry'
                }
              />
            )}
          </form.Field>
        </Field>
        <Field label="Cooking steps" hint="Put each step on a new line.">
          <form.Field name="steps">
            {(field) => (
              <Textarea
                required
                rows={5}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={
                  'Cook the rice according to the package instructions.\nSeason and cook the chicken, then slice.'
                }
              />
            )}
          </form.Field>
        </Field>
        <Field label="Prep ahead & storage">
          <form.Field name="storage">
            {(field) => (
              <Textarea
                rows={2}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="How to store or freeze leftovers"
              />
            )}
          </form.Field>
        </Field>
        <Field label="A variation">
          <form.Field name="variation">
            {(field) => (
              <Textarea
                rows={2}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="A swap that keeps it interesting"
              />
            )}
          </form.Field>
        </Field>
        {formError && (
          <Alert variant="destructive">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        )}
        <div className="form-footer">
          <Button variant="outline" size="default" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="default"
            type="submit"
            disabled={busy || isSubmitting || !name.trim()}
          >
            {busy || isSubmitting ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            Save recipe
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
