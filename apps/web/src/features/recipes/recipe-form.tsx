'use client';

import { useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { Ingredient, Macros, Recipe, RecipeCategory } from '@packages/nutrition/types';
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

export default function RecipeForm({
  recipe,
  busy,
  onClose,
  onSave,
}: {
  recipe?: Recipe;
  busy: boolean;
  onClose: () => void;
  onSave: (recipe: Recipe) => void;
}) {
  const [recipeId] = useState(() => recipe?.id || newId());
  const [createdAt] = useState(() => recipe?.createdAt || new Date().toISOString());
  const [name, setName] = useState(recipe?.name || '');
  const [description, setDescription] = useState(recipe?.description || '');
  const [category, setCategory] = useState<RecipeCategory>(recipe?.category || 'main');
  const [prep, setPrep] = useState(recipe?.prepMinutes || 10);
  const [cook, setCook] = useState(recipe?.cookMinutes || 15);
  const [nutrition, setNutrition] = useState<Macros>(recipe?.nutrition || { ...zero });
  const [ingredients, setIngredients] = useState(
    recipe?.ingredients
      .map(
        (i) => `${i.quantity} | ${i.unit} | ${i.name} | ${i.aisle}${i.note ? ` | ${i.note}` : ''}`,
      )
      .join('\n') || '',
  );
  const [steps, setSteps] = useState(recipe?.steps.join('\n') || '');
  const [storage, setStorage] = useState(recipe?.storage || '');
  const [variation, setVariation] = useState(recipe?.variation || '');
  const [formError, setFormError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    const parsed: Ingredient[] = [];
    for (const line of ingredients.split('\n').filter((s) => s.trim())) {
      const parts = line.split('|').map((s) => s.trim());
      if (
        parts.length < 3 ||
        !parts[0] ||
        !Number.isFinite(Number(parts[0])) ||
        Number(parts[0]) <= 0 ||
        !parts[1] ||
        !parts[2]
      ) {
        setFormError(
          'Please enter each ingredient as quantity | unit | ingredient | aisle. Example: 150 | g | chicken breast, raw | Meat & seafood',
        );
        return;
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
    if (!parsed.length || !steps.trim()) {
      setFormError('Add at least one ingredient and one cooking step.');
      return;
    }
    onSave({
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
  };
  return (
    <Dialog title={recipe ? 'Edit recipe' : 'Add a new recipe'} onClose={onClose} wide>
      <form className="dialog-form" onSubmit={submit}>
        <Field label="Recipe name">
          <Input
            required
            maxLength={160}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Give this one a name"
          />
        </Field>
        <Field label="A little about it">
          <Input
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What makes this a good addition to your rotation?"
          />
        </Field>
        <div className="form-three">
          <Field label="Category">
            <NativeSelect
              value={category}
              onChange={(e) => setCategory(e.target.value as RecipeCategory)}
            >
              <NativeSelectOption value="breakfast">Breakfast</NativeSelectOption>
              <NativeSelectOption value="main">Main meal</NativeSelectOption>
              <NativeSelectOption value="snack">Snack & fuel</NativeSelectOption>
            </NativeSelect>
          </Field>
          <Field label="Prep time (min)">
            <Input
              required
              type="number"
              min={0}
              max={1440}
              value={prep}
              onChange={(e) => setPrep(Number(e.target.value))}
            />
          </Field>
          <Field label="Cook time (min)">
            <Input
              required
              type="number"
              min={0}
              max={1440}
              value={cook}
              onChange={(e) => setCook(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="form-section-label">NUTRITION & INGREDIENTS FOR ONE SERVING</div>
        <MacroFields value={nutrition} onChange={setNutrition} />
        <Field
          label="Ingredients"
          hint="One per line: quantity | unit | ingredient | aisle | optional note. Use raw meat and dry grain weights for easy shopping."
        >
          <Textarea
            required
            rows={5}
            value={ingredients}
            onChange={(e) => setIngredients(e.target.value)}
            placeholder={
              '150 | g | Chicken breast, raw | Meat & seafood\n75 | g | Rice, dry | Pantry\n1 | tbsp | Olive oil | Pantry'
            }
          />
        </Field>
        <Field label="Cooking steps" hint="Put each step on a new line.">
          <Textarea
            required
            rows={5}
            value={steps}
            onChange={(e) => setSteps(e.target.value)}
            placeholder={
              'Cook the rice according to the package instructions.\nSeason and cook the chicken, then slice.'
            }
          />
        </Field>
        <Field label="Prep ahead & storage">
          <Textarea
            rows={2}
            value={storage}
            onChange={(e) => setStorage(e.target.value)}
            placeholder="How to store or freeze leftovers"
          />
        </Field>
        <Field label="A variation">
          <Textarea
            rows={2}
            value={variation}
            onChange={(e) => setVariation(e.target.value)}
            placeholder="A swap that keeps it interesting"
          />
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
          <Button variant="default" size="default" type="submit" disabled={busy || !name.trim()}>
            {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save recipe
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
