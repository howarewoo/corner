import type { AppState, Recipe } from '@packages/shared/types';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@packages/ui';
import RecipeDetail from '../recipes/recipe-detail';
import RecipeForm from '../recipes/recipe-form';
import FoodForm from '../food-log/food-form';
import RecipePicker from '../meal-planner/recipe-picker';
import type { Confirmation, Mutate, Overlay } from './types';

export default function WorkspaceOverlays({
  state,
  selectedDate,
  disabled,
  busy,
  aiAvailable,
  overlay,
  setOverlay,
  confirmation,
  setConfirmation,
  mutate,
  saveRecipe,
}: {
  state: AppState;
  selectedDate: string;
  disabled: boolean;
  busy: boolean;
  aiAvailable: boolean;
  overlay: Overlay;
  setOverlay: (overlay: Overlay) => void;
  confirmation: Confirmation | null;
  setConfirmation: (confirmation: Confirmation | null) => void;
  mutate: Mutate;
  saveRecipe: (recipe: Recipe) => Promise<void>;
}) {
  return (
    <>
      {overlay?.kind === 'recipe' && (
        <RecipeDetail
          recipe={state.recipes.find((r) => r.id === overlay.recipe.id) || overlay.recipe}
          busy={disabled}
          saved={state.recipes.some((r) => r.id === overlay.recipe.id)}
          onClose={() => setOverlay(null)}
          onFavorite={(recipe) =>
            void mutate({
              type: 'recipe.favorite',
              data: { id: recipe.id, favorite: !recipe.favorite },
            })
          }
          onEdit={(recipe) => setOverlay({ kind: 'recipeForm', recipe })}
          onPlan={(recipe) =>
            setOverlay({
              kind: 'pick',
              date: selectedDate,
              slot:
                recipe.category === 'breakfast'
                  ? 'breakfast'
                  : recipe.category === 'snack'
                    ? 'snack'
                    : 'dinner',
              recipeId: recipe.id,
            })
          }
          onSave={saveRecipe}
          onDelete={(recipe) =>
            setConfirmation({
              title: `Delete “${recipe.name}”?`,
              description:
                'Remove any uses of this recipe from your meal plan first. Existing food log entries keep their nutrition.',
              confirm: async () => {
                const deleted = await mutate(
                  { type: 'recipe.delete', data: { id: recipe.id } },
                  'Recipe deleted',
                );
                if (deleted) setOverlay(null);
                return deleted;
              },
            })
          }
        />
      )}
      {overlay?.kind === 'recipeForm' && (
        <RecipeForm
          recipe={overlay.recipe}
          busy={disabled}
          onClose={() => setOverlay(null)}
          onSave={saveRecipe}
        />
      )}
      {overlay?.kind === 'food' && (
        <FoodForm
          food={overlay.food}
          date={selectedDate}
          busy={disabled}
          aiAvailable={aiAvailable}
          onClose={() => setOverlay(null)}
          onSave={async (food) => {
            if (await mutate({ type: 'log.save', data: food }, 'Food log saved')) setOverlay(null);
          }}
        />
      )}
      {overlay?.kind === 'pick' && (
        <RecipePicker
          recipes={state.recipes}
          date={overlay.date}
          slot={overlay.slot}
          initialRecipeId={overlay.recipeId}
          busy={disabled}
          onClose={() => setOverlay(null)}
          onAdd={async (recipe, date, slot, servings, entryId) => {
            if (
              await mutate(
                {
                  type: 'plan.save',
                  data: { id: entryId, date, slot, recipeId: recipe.id, servings },
                },
                'Meal added to your plan',
              )
            )
              setOverlay(null);
          }}
        />
      )}
      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent className="corner-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (confirmation && (await confirmation.confirm())) setConfirmation(null);
              }}
            >
              {busy ? 'Saving…' : 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
