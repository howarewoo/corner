'use client';

import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Settings } from '@packages/workspace/types';
import type { Recipe, RecipeRequest } from '@packages/nutrition/types';
import type { Mutate, Notify } from '../workspace/types';
import { rpc, scoped, errorCode, sessionLifetime } from '../../rpc';
import { newId } from '../workspace/utils';

export function useRecipeStudio({
  initialSettings,
  settings,
  aiAvailable,
  mutate,
  notify,
}: {
  initialSettings: Settings;
  settings: Settings;
  aiAvailable: boolean;
  mutate: Mutate;
  notify: Notify;
}) {
  const generation = useRef(sessionLifetime()).current;
  const [studioPrompt, setStudioPrompt] = useState('');
  const [studioCalories, setStudioCalories] = useState(
    initialSettings.training.calories > 0
      ? Math.round(initialSettings.training.calories / 4)
      : 500,
  );
  const [studioProtein, setStudioProtein] = useState(
    initialSettings.training.protein > 0
      ? Math.round(initialSettings.training.protein / 4)
      : 25,
  );
  const [studioMinutes, setStudioMinutes] = useState(25);
  const recipeMutation = useMutation({
    mutationFn: (input: Parameters<typeof rpc.ai.generateRecipe>[0]) =>
      scoped(() => rpc.ai.generateRecipe(input), generation),
    retry: false,
  });
  const [generated, setGenerated] = useState<Recipe | null>(null);
  const generationLock = useRef(false);
  const generationIntent = useRef<{ signature: string; requestId: string } | null>(null);

  const studioBrief = (request?: RecipeRequest) =>
    `Recipe idea: ${request?.prompt || studioPrompt}\n\nPreferences: about ${request?.calories || studioCalories} calories, ${request?.protein || studioProtein} g protein per serving, ready in ${request?.maxMinutes || studioMinutes} minutes.\nDietary preferences: ${settings.profile?.dietaryPreferences || 'Not specified'}\nGroceries: ${settings.profile?.groceryPreferences || 'Not specified'}\nGoals: ${settings.profile?.goals || 'Not specified'}`;
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
    if (generation !== sessionLifetime() || generationLock.current) return;
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
    try {
      const payload = await recipeMutation.mutateAsync({
        prompt: studioPrompt.trim(),
        calories: studioCalories,
        protein: studioProtein,
        maxMinutes: studioMinutes,
        requestId: generationRequestId,
      });
      if (generation !== sessionLifetime()) return;
      setGenerated(payload.recipe);
      generationIntent.current = null;
    } catch (error) {
      const code = errorCode(error);
      if (code && !code.endsWith('_PENDING') && code !== 'AI_BUSY' && code !== 'DAILY_LIMIT')
        generationIntent.current = null;
      notify(
        code === 'AI_NOT_CONFIGURED'
          ? 'Connect your AI account in My agent to generate a recipe.'
          : error instanceof Error
            ? error.message
            : 'Could not generate a recipe.',
        true,
      );
    } finally {
      generationLock.current = false;
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
    generating: recipeMutation.isPending,
    generated,
    setGenerated,
    studioBrief,
    saveRequest,
    generateRecipe,
    clearGenerated: () => setGenerated(null),
  };
}
