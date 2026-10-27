'use client';

import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  Loader2,
  Plus,
  ShoppingBasket,
  Sparkles,
  UtensilsCrossed,
} from 'lucide-react';
import type { AppState, Settings } from '@packages/workspace/types';
import type { Recipe } from '@packages/nutrition/types';
import { Badge, Button, Card, Input, Textarea, WorkspaceHeader } from '@packages/ui';
import type { View } from '../workspace/types';
import { cap } from '../workspace/utils';
import { Field, MacroLine, ResourceStatus, ResourcePaging } from '../workspace/workspace-ui';
import { useRecordPage } from '../workspace/resources';
import { rpc, useResource } from '../../rpc';
import type { useRecipeStudio } from './use-recipe-studio';

export default function RecipeStudio({
  state,
  settings,
  aiAvailable,
  disabled,
  studio,
  navigate,
  openAgent,
  openRecipe,
  saveRecipe,
  copyText,
}: {
  state?: AppState;
  settings: Settings;
  aiAvailable: boolean;
  disabled: boolean;
  studio: ReturnType<typeof useRecipeStudio>;
  navigate: (view: View) => void;
  openAgent: (prompt?: string) => void;
  openRecipe: (recipe: Recipe) => void;
  saveRecipe: (recipe: Recipe) => Promise<void>;
  copyText: (text: string, success?: string) => Promise<void>;
}) {
  const {
    studioPrompt,
    setStudioPrompt,
    studioCalories,
    setStudioCalories,
    studioProtein,
    setStudioProtein,
    studioMinutes,
    setStudioMinutes,
    generating,
    generated,
    studioBrief,
    saveRequest,
    generateRecipe,
  } = studio;
  const page = useRecordPage({ resource: 'recipeRequests', order: 'recent', limit: 20 }, !state);
  const requests = state ? [...state.requests].reverse() : (page.data?.items ?? []);
  const recipeIds = [
    ...new Set(requests.flatMap((request) => (request.recipeId ? [request.recipeId] : []))),
  ];
  const details = useResource(
    'details',
    { recipeIds, revision: page.data?.revision },
    (signal) => rpc.workspace.details({ recipeIds }, { signal }),
    !state && Boolean(page.data),
  );
  const recipes = state?.recipes ?? details.data?.recipes ?? [];
  const drift = !state && page.data && details.data && page.data.revision !== details.data.revision;
  const historyReady = Boolean(
    state || (page.data && details.data && !drift && !page.isError && !details.isError),
  );
  const reloadHistory = () => {
    page.reload();
    void details.refetch();
  };

  return (
    <>
      <WorkspaceHeader
        title="Recipe studio."
        eyebrow="SOMETHING NEW FOR THE ROTATION"
        description="A craving, a few ingredients, a fresh idea. Start there."
        actions={
          <>
            <Badge
              variant="secondary"
              className={`studio-status ${aiAvailable ? 'connected' : ''}`}
            >
              <span className="status-dot" />
              {aiAvailable ? 'AI connection ready' : 'Connect AI to generate'}
            </Badge>
          </>
        }
      />
      <div className="studio-layout">
        <div>
          <Card className="panel studio-form">
            <div className="studio-intro-icon">
              <Sparkles size={23} />
            </div>
            <h2>What sounds good?</h2>
            <p>Tell us what you’re craving, what’s in the fridge, or what you’d like to change.</p>
            <Field label="Your recipe idea">
              <Textarea
                value={studioPrompt}
                onChange={(e) => setStudioPrompt(e.target.value)}
                rows={5}
                maxLength={1600}
                placeholder="A flavorful dinner using what I have, easy to prep and suited to my food preferences…"
              />
            </Field>
            <div className="suggestion-chips">
              {[
                'A 20-minute high-protein dinner',
                'A snack for a busy afternoon',
                'Use up tofu and frozen vegetables',
              ].map((idea) => (
                <Button
                  variant="ghost"
                  size="default"
                  key={idea}
                  onClick={() => setStudioPrompt(idea)}
                >
                  <Plus size={12} />
                  {idea}
                </Button>
              ))}
            </div>
            <div className="studio-targets">
              <Field label="Calories per serving">
                <Input
                  type="number"
                  value={studioCalories}
                  min={150}
                  max={1500}
                  step={25}
                  onChange={(e) => setStudioCalories(Number(e.target.value))}
                />
              </Field>
              <Field label="Protein goal (g)">
                <Input
                  type="number"
                  value={studioProtein}
                  min={5}
                  max={120}
                  onChange={(e) => setStudioProtein(Number(e.target.value))}
                />
              </Field>
              <Field label="Total time (min)">
                <Input
                  type="number"
                  value={studioMinutes}
                  min={5}
                  max={120}
                  step={5}
                  onChange={(e) => setStudioMinutes(Number(e.target.value))}
                />
              </Field>
            </div>
            {!aiAvailable && (
              <div className="connection-note">
                <Sparkles size={17} />
                <div>
                  <b>In-app generation needs an AI connection</b>
                  <p>
                    Connect your AI account in My agent, or save the idea and add a recipe manually.
                  </p>
                </div>
              </div>
            )}
            <div className="studio-actions">
              {aiAvailable ? (
                <Button
                  variant="default"
                  size="default"
                  disabled={disabled || generating || !studioPrompt.trim()}
                  onClick={() => void generateRecipe()}
                >
                  {generating ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                  {generating ? 'Creating your recipe…' : 'Create recipe'}
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="default"
                  disabled={disabled || !studioPrompt.trim()}
                  onClick={() => void saveRequest()}
                >
                  <Plus size={16} />
                  Save recipe idea
                </Button>
              )}
              <Button
                variant="outline"
                size="default"
                disabled={!studioPrompt.trim()}
                onClick={() => void copyText(studioBrief(), 'Recipe brief copied.')}
              >
                <Copy size={16} />
                Copy brief
              </Button>
              <Button variant="ghost" size="default" onClick={() => openAgent(studioBrief())}>
                Open my agent <ArrowUpRight size={15} />
              </Button>
            </div>
          </Card>
          {generated && (
            <Card className="panel generated-recipe">
              <div className="panel-heading">
                <div>
                  <div className="eyebrow">YOUR NEW RECIPE · DRAFT</div>
                  <h2>{generated.name}</h2>
                </div>
                <Sparkles size={20} />
              </div>
              <p>{generated.description}</p>
              <MacroLine nutrition={generated.nutrition} />
              <p className="muted small-text">
                Review the ingredients and nutrition before adding this to your collection.
              </p>
              <div className="button-row">
                <Button variant="outline" size="default" onClick={() => openRecipe(generated)}>
                  Review recipe
                </Button>
                <Button
                  variant="default"
                  size="default"
                  disabled={disabled}
                  onClick={() => void saveRecipe(generated)}
                >
                  <Plus size={16} />
                  Save recipe
                </Button>
              </div>
            </Card>
          )}
        </div>
        <aside className="studio-aside">
          <div className="studio-tip">
            <span className="eyebrow">Your preferences</span>
            <h2>Made for your routine.</h2>
            <p>Recipe suggestions use the preferences you save in your profile.</p>
            <div className="studio-preferences">
              <span>
                <ShoppingBasket size={16} />
                {settings.profile?.groceryPreferences || 'Add your grocery preferences'}
              </span>
              <span>
                <UtensilsCrossed size={16} />
                {settings.profile?.dietaryPreferences || 'Add your food preferences'}
              </span>
              <Button variant="link" size="default" onClick={() => navigate('settings')}>
                Edit profile <ArrowRight size={15} />
              </Button>
            </div>
          </div>
          <div className="request-list">
            <div className="section-heading">
              <h2>Recipe requests</h2>
              <span>
                {requests.length}
                {!state ? ' on this page' : ''}
              </span>
            </div>
            {!historyReady ? (
              <ResourceStatus
                error={
                  page.error ??
                  details.error ??
                  (drift ? new Error('Your data changed while loading. Please retry.') : null)
                }
                loading={!page.isError && !details.isError}
                retry={reloadHistory}
              />
            ) : requests.length ? (
              requests.map((request) => (
                <div className="request-item" key={request.id}>
                  <Badge variant="secondary" className={`request-status ${request.status}`}>
                    {request.status === 'fulfilled' ? <Check size={12} /> : <Clock3 size={12} />}
                    {cap(request.status)}
                  </Badge>
                  <h3>{request.prompt}</h3>
                  <p>
                    {request.calories} kcal · {request.protein}g protein · {request.maxMinutes} min
                  </p>
                  {request.status === 'fulfilled' &&
                  request.recipeId &&
                  recipes.find((r) => r.id === request.recipeId) ? (
                    <Button
                      variant="link"
                      size="default"
                      onClick={() => openRecipe(recipes.find((r) => r.id === request.recipeId)!)}
                    >
                      View recipe <ArrowRight size={13} />
                    </Button>
                  ) : (
                    <Button
                      variant="link"
                      size="default"
                      onClick={() => void copyText(studioBrief(request), 'Request brief copied')}
                    >
                      Copy request brief <Copy size={13} />
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <p className="muted request-empty">
                Your saved ideas will appear here. Keep a running list for your next meal prep.
              </p>
            )}
            {!state && <ResourcePaging {...page.paging} />}
          </div>
        </aside>
      </div>
    </>
  );
}
