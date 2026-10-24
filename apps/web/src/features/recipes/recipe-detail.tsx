'use client';

import { useState } from 'react';
import {
  ArrowDownToLine,
  CalendarDays,
  Clock3,
  Heart,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Ingredient, Macros, Recipe } from '@packages/shared/types';
import { Badge, Button, Input } from '@packages/ui';
import { cap, download, macroNames, num } from '../workspace/utils';
import { Dialog, IconButton } from '../workspace/workspace-ui';

function ingredientAmount(ingredient: Ingredient, servings: number) {
  if (servings === 1 && ingredient.display) return ingredient.display;
  const qualifiers = Array.from(
    new Set((ingredient.display || '').match(/\b(?:cooked|raw|dry|drained)\b/gi) || []),
  ).filter((qualifier) => !ingredient.unit.toLowerCase().includes(qualifier.toLowerCase()));
  return `${num(ingredient.quantity * servings, 2)} ${ingredient.unit}${qualifiers.length ? ` ${qualifiers.join(', ').toLowerCase()}` : ''}`;
}

export default function RecipeDetail({
  recipe,
  busy,
  saved,
  onClose,
  onFavorite,
  onEdit,
  onPlan,
  onSave,
  onDelete,
}: {
  recipe: Recipe;
  busy: boolean;
  saved: boolean;
  onClose: () => void;
  onFavorite: (recipe: Recipe) => void;
  onEdit: (recipe: Recipe) => void;
  onPlan: (recipe: Recipe) => void;
  onSave: (recipe: Recipe) => void;
  onDelete: (recipe: Recipe) => void;
}) {
  const [servings, setServings] = useState(1);
  const downloadRecipe = () => {
    const text = [
      recipe.name,
      recipe.description,
      `${recipe.prepMinutes} min prep · ${recipe.cookMinutes} min cook · ${num(servings, 2)} ${servings === 1 ? 'serving' : 'servings'}`,
      '',
      `ESTIMATED NUTRITION — TOTAL FOR ${num(servings, 2)} ${servings === 1 ? 'SERVING' : 'SERVINGS'}`,
      ...Object.entries(macroNames).map(
        ([key, label]) =>
          `${label}: ${num(recipe.nutrition[key as keyof Macros] * servings, 1)} ${key === 'calories' ? 'kcal' : 'g'}`,
      ),
      '',
      'INGREDIENTS',
      ...recipe.ingredients.map(
        (ingredient) =>
          `- ${ingredientAmount(ingredient, servings)} ${ingredient.name}${ingredient.optional ? ' (optional)' : ''}${ingredient.note ? ` — ${ingredient.note}` : ''}`,
      ),
      '',
      'METHOD',
      ...recipe.steps.map((step, index) => `${index + 1}. ${step}`),
      ...(recipe.storage ? ['', 'PREP AHEAD & STORAGE', recipe.storage] : []),
      ...(recipe.variation ? ['', 'VARIATION', recipe.variation] : []),
      '',
      'NUTRITION NOTES',
      'Nutrition and ingredient amounts above scale with the selected servings. Method and storage notes are from the original recipe. Check product labels and actual portions.',
      ...(recipe.nutritionNote ? [`Original recipe notes: ${recipe.nutritionNote}`] : []),
    ].join('\n');
    const filename =
      recipe.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'recipe';
    download(text, `${filename}.txt`, 'text/plain;charset=utf-8');
  };
  return (
    <Dialog title={recipe.name} onClose={onClose} wide>
      <div className="recipe-detail">
        <div className="detail-topline">
          <Badge variant="secondary" className={`category-tag ${recipe.category}`}>
            {recipe.category === 'main' ? 'Main meal' : cap(recipe.category)}
          </Badge>
          <span>
            <Clock3 size={14} />
            {recipe.prepMinutes} min prep · {recipe.cookMinutes} min cook
          </span>
          {saved && (
            <Button
              variant="link"
              size="default"
              disabled={busy}
              onClick={() => onFavorite(recipe)}
            >
              <Heart size={15} fill={recipe.favorite ? 'currentColor' : 'none'} />
              {recipe.favorite ? 'Saved favorite' : 'Favorite'}
            </Button>
          )}
        </div>
        <p className="detail-description">{recipe.description}</p>
        <div className="detail-macro-caption">
          Estimated nutrition ·{' '}
          {servings === 1 ? 'Per serving' : `Total for ${num(servings, 2)} servings`}
        </div>
        <div className="detail-macros">
          {Object.entries(macroNames).map(([key, label]) => (
            <div key={key}>
              <strong>
                {num(recipe.nutrition[key as keyof Macros] * servings)}
                <small>{key === 'calories' ? 'kcal' : 'g'}</small>
              </strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="detail-section-heading">
          <h3>Ingredients</h3>
          <div className="serving-stepper">
            <span>Servings</span>
            <Button
              variant="ghost"
              size="default"
              type="button"
              disabled={servings <= 0.5}
              aria-label="Decrease servings"
              onClick={() => setServings((n) => Math.max(0.5, n - 0.5))}
            >
              −
            </Button>
            <Input
              aria-label="Recipe servings"
              type="number"
              min={0.25}
              max={20}
              step={0.25}
              value={servings}
              onChange={(e) =>
                setServings(Math.min(20, Math.max(0.25, Number(e.target.value) || 0.25)))
              }
            />
            <Button
              variant="ghost"
              size="default"
              type="button"
              disabled={servings >= 20}
              aria-label="Increase servings"
              onClick={() => setServings((n) => Math.min(20, n + 0.5))}
            >
              +
            </Button>
          </div>
        </div>
        <ul className="ingredient-list">
          {recipe.ingredients.map((ingredient, index) => (
            <li key={index}>
              <span className="ingredient-bullet" />
              <span>
                <b>{ingredient.name}</b>
                {ingredient.optional && <small> optional</small>}
                {ingredient.note && <small className="ingredient-note">{ingredient.note}</small>}
              </span>
              <strong>
                {ingredientAmount(ingredient, servings)}
                {servings !== 1 && ingredient.display && (
                  <small className="ingredient-original">Per serving: {ingredient.display}</small>
                )}
              </strong>
            </li>
          ))}
        </ul>
        <h3 className="detail-section-title">Make it happen</h3>
        <ol className="recipe-steps">
          {recipe.steps.map((step, index) => (
            <li key={index}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
        {recipe.storage && (
          <div className="recipe-note">
            <h4>
              <CalendarDays size={16} />
              Prep ahead & storage
            </h4>
            <p>{recipe.storage}</p>
          </div>
        )}
        {recipe.variation && (
          <div className="recipe-note variation-note">
            <h4>
              <Sparkles size={16} />
              Keep it interesting
            </h4>
            <p>{recipe.variation}</p>
          </div>
        )}
        <p className="nutrition-disclaimer">
          {servings !== 1 && (
            <span>Nutrition above is the total for {num(servings, 2)} servings. </span>
          )}
          {recipe.nutritionNote
            ? `${servings !== 1 ? 'Original recipe notes: ' : ''}${recipe.nutritionNote}`
            : 'Nutrition is an estimate. Check your product labels and actual portions. Values above scale with the servings selected.'}
        </p>
        <div className="detail-actions">
          <div className="button-row">
            {saved ? (
              <Button variant="default" size="default" onClick={() => onPlan(recipe)}>
                <Plus size={15} />
                Add to meal plan
              </Button>
            ) : (
              <Button
                variant="default"
                size="default"
                disabled={busy}
                onClick={() => onSave(recipe)}
              >
                <Plus size={15} />
                Save recipe
              </Button>
            )}
            {saved && (
              <Button variant="outline" size="default" onClick={() => onEdit(recipe)}>
                <Pencil size={14} />
                Edit
              </Button>
            )}
            <Button variant="ghost" size="default" onClick={downloadRecipe}>
              <ArrowDownToLine size={15} />
              Download recipe (.txt)
            </Button>
          </div>
          {saved && (
            <IconButton label="Delete recipe" disabled={busy} onClick={() => onDelete(recipe)}>
              <Trash2 size={16} />
            </IconButton>
          )}
        </div>
      </div>
    </Dialog>
  );
}
