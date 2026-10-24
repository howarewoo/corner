'use client';

import { useRef, useState } from 'react';
import type { AppState, Recipe, RecipeRequest } from '@packages/shared/types';
import type { ApiPayload, Mutate, Notify } from '../workspace/types';
import { newId } from '../workspace/utils';

export function useRecipeStudio({
  initialState,
  state,
  aiAvailable,
  mutate,
  notify,
}: {
  initialState: AppState;
  state: AppState;
  aiAvailable: boolean;
  mutate: Mutate;
  notify: Notify;
}) {
  const [studioPrompt, setStudioPrompt] = useState('');
  const [studioCalories, setStudioCalories] = useState(
    initialState.settings.training.calories > 0
      ? Math.round(initialState.settings.training.calories / 4)
      : 500,
  );
  const [studioProtein, setStudioProtein] = useState(
    initialState.settings.training.protein > 0
      ? Math.round(initialState.settings.training.protein / 4)
      : 25,
  );
  const [studioMinutes, setStudioMinutes] = useState(25);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<Recipe | null>(null);
  const generationLock = useRef(false);
  const generationIntent = useRef<{ signature: string; requestId: string } | null>(null);

  const studioBrief = (request?: RecipeRequest) =>
    `Recipe idea: ${request?.prompt || studioPrompt}\n\nPreferences: about ${request?.calories || studioCalories} calories, ${request?.protein || studioProtein} g protein per serving, ready in ${request?.maxMinutes || studioMinutes} minutes.\nDietary preferences: ${state.settings.profile?.dietaryPreferences || 'Not specified'}\nGroceries: ${state.settings.profile?.groceryPreferences || 'Not specified'}\nGoals: ${state.settings.profile?.goals || 'Not specified'}`;
  const saveRequest = async () => {
    if (!studioPrompt.trim()) {
      notify('Describe the recipe you want first.', true);
      return;
    }
    await mutate(
      {
        type: 'request.save',
        data: {
          id: newId(),
          prompt: studioPrompt.trim(),
          calories: studioCalories,
          protein: studioProtein,
          maxMinutes: studioMinutes,
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      },
      'Recipe idea saved.',
    );
  };
  const generateRecipe = async () => {
    if (generationLock.current) return;
    if (!studioPrompt.trim()) {
      notify('Describe the recipe you want first.', true);
      return;
    }
    if (!aiAvailable) {
      notify('Connect your AI account in My agent to generate a recipe.');
      return;
    }
    if (
      studioPrompt.trim().length < 8 ||
      studioPrompt.trim().length > 1600 ||
      studioCalories < 150 ||
      studioCalories > 1500 ||
      studioProtein < 5 ||
      studioProtein > 120 ||
      studioMinutes < 5 ||
      studioMinutes > 120
    ) {
      notify(
        'Describe your idea in at least 8 characters. Choose 150–1,500 calories, 5–120 g protein, and 5–120 minutes.',
        true,
      );
      return;
    }
    const signature = JSON.stringify({
      prompt: studioPrompt.trim(),
      calories: studioCalories,
      protein: studioProtein,
      maxMinutes: studioMinutes,
    });
    if (generationIntent.current?.signature !== signature)
      generationIntent.current = { signature, requestId: newId() };
    const generationRequestId = generationIntent.current.requestId;
    generationLock.current = true;
    setGenerating(true);
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: studioPrompt.trim(),
          calories: studioCalories,
          protein: studioProtein,
          maxMinutes: studioMinutes,
          requestId: generationRequestId,
        }),
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok || !payload.recipe) {
        const code =
          payload.code || (typeof payload.error === 'object' ? payload.error?.code : undefined);
        if (!code?.endsWith('_PENDING') && code !== 'AI_BUSY' && code !== 'DAILY_LIMIT')
          generationIntent.current = null;
        throw new Error(
          payload.code === 'AI_NOT_CONFIGURED' ||
            payload.error === 'AI_NOT_CONFIGURED' ||
            (typeof payload.error === 'object' && payload.error?.code === 'AI_NOT_CONFIGURED')
            ? 'Connect your AI account in My agent to generate a recipe.'
            : typeof payload.error === 'string'
              ? payload.error
              : payload.error?.message || 'The recipe could not be generated. Please try again.',
        );
      }
      setGenerated(payload.recipe);
      generationIntent.current = null;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not generate a recipe.', true);
    } finally {
      generationLock.current = false;
      setGenerating(false);
    }
  };

  return {
    studioPrompt,
    setStudioPrompt,
    studioCalories,
    setStudioCalories,
    studioProtein,
    setStudioProtein,
    studioMinutes,
    setStudioMinutes,
    generating,
    setGenerating,
    generated,
    setGenerated,
    studioBrief,
    saveRequest,
    generateRecipe,
    clearGenerated: () => setGenerated(null),
  };
}
