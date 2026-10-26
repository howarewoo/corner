import type { AppState } from '@packages/workspace/types';
import type { Recipe } from '@packages/nutrition/types';
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
import { rpc, useResource } from '../../rpc';
import { Dialog, ResourceStatus } from './workspace-ui';

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
  state?: AppState;
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
  const recipeId = overlay?.kind === 'recipe' ? overlay.recipe.id : undefined;
  const detail = useResource('details', { recipeIds: recipeId ? [recipeId] : [] },
    (signal) => rpc.workspace.details({ recipeIds: recipeId ? [recipeId] : [] }, { signal }),
    !state && Boolean(recipeId));
  const savedRecipe = (state?.recipes ?? detail.data?.recipes ?? []).find((recipe) => recipe.id === recipeId);
  return (
    <>
      {overlay?.kind === 'recipe' && !state && (!detail.data || detail.isError) ?
        <Dialog title="Recipe" onClose={() => setOverlay(null)}><ResourceStatus error={detail.error} loading={detail.isPending} retry={() => void detail.refetch()} /></Dialog>
        : overlay?.kind === 'recipe' && (
        <RecipeDetail
          recipe={savedRecipe || overlay.recipe}
          busy={disabled}
          saved={Boolean(savedRecipe)}
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
          recipes={state?.recipes}
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
