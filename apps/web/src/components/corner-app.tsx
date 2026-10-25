'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useRoutes } from 'react-router';
import { Dumbbell, Home, Settings2, Sparkles, UtensilsCrossed } from 'lucide-react';
import type { Recipe } from '@packages/nutrition/types';
import { dateKey } from '@packages/nutrition/dates';
import {
  AppSidebar,
  Avatar,
  AvatarFallback,
  Button,
  SidebarInset,
  SidebarProvider,
  ThemePicker,
  Toaster,
  ToggleGroup,
  ToggleGroupItem,
  useSidebar,
  WorkspaceHeader,
  WorkspaceMobileBar,
  type MobileNavigation,
} from '@packages/ui';
import AgentPanel from '../agent-panel';
import TrainingPanel from './training-panel';
import Today from '../features/today/today';
import MealPlanner from '../features/meal-planner/meal-planner';
import RecipeCollection, { useRecipeFilters } from '../features/recipes/recipe-collection';
import RecipeStudio from '../features/recipe-studio/recipe-studio';
import { useRecipeStudio } from '../features/recipe-studio/use-recipe-studio';
import Groceries from '../features/groceries/groceries';
import Settings from '../features/settings/settings';
import WorkspaceOverlays from '../features/workspace/workspace-overlays';
import { useWorkspaceState } from '../features/workspace/use-workspace-state';
import { isNutritionView, sidebarGroups, viewPaths } from '../features/workspace/navigation';
import type { Confirmation, CornerAppProps, Overlay, View } from '../features/workspace/types';
import { useTheme } from '../theme';
import './training.css';
import './food-estimator.css';
import './food-entry.css';

export default function CornerApp(props: CornerAppProps) {
  const routes = useRoutes([
    ...Object.entries(viewPaths).map(([view, path]) => ({
      path,
      element: <CornerWorkspace {...props} view={view as View} />,
    })),
    { path: '*', element: <Navigate to="/" replace /> },
  ]);
  return (
    <SidebarProvider open mobileLayout="fullscreen" className="corner-ui">
      {routes}
    </SidebarProvider>
  );
}
function CornerWorkspace({
  initialState,
  preview,
  displayName,
  initialRevision = 0,
  accountEmail,
  signingOut,
  onSignOut,
  view,
}: CornerAppProps & { view: View }) {
  const { isMobile } = useSidebar();
  const theme = useTheme();
  const [lastNutritionView, setLastNutritionView] = useState<
    'planner' | 'recipes' | 'groceries' | 'studio'
  >(isNutritionView(view) ? view : 'planner');
  const workspaceContent = useRef<HTMLDivElement>(null);
  const routerNavigate = useNavigate();
  const location = useLocation();
  const [agentPrompt, setAgentPrompt] = useState('');
  const [selectedDate, setSelectedDate] = useState(() =>
    dateKey(new Date(), initialState.settings.timezone),
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const {
    state,
    revision,
    busy,
    disabled,
    aiAvailable,
    notifications,
    notify,
    readState,
    mutate,
    copyText,
  } = useWorkspaceState({ initialState, initialRevision, preview });
  // These hooks stay mounted with the workspace so drafts and filters survive navigation.
  const recipeFilters = useRecipeFilters();
  const studio = useRecipeStudio({ initialState, state, aiAvailable, mutate, notify });
  useEffect(() => {
    if (isNutritionView(view)) setLastNutritionView(view);
    setOverlay(null);
    setConfirmation(null);
    workspaceContent.current?.scrollTo({ top: 0 });
    workspaceContent.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [location.key, view]);
  const navigate = (next: View) => {
    if (next !== view) void routerNavigate(viewPaths[next]);
  };
  const openAgent = (prompt = '') => {
    setAgentPrompt(prompt);
    navigate('agent');
  };
  const firstName = (state.settings.name || displayName || 'you').split(' ')[0];
  const openRecipe = (recipe: Recipe) => setOverlay({ kind: 'recipe', recipe });
  const saveRecipe = async (recipe: Recipe) => {
    if (await mutate({ type: 'recipe.save', data: recipe }, 'Recipe saved to your collection')) {
      setOverlay(null);
      studio.clearGenerated();
    }
  };
  const mobileNavigation = useMemo<MobileNavigation<View>>(
    () => ({
      label: 'Corner navigation',
      selectedId: isNutritionView(view) ? view : view === 'workouts' ? 'workouts' : 'today',
      items: [
        {
          id: 'today' as const,
          label: 'Home',
          href: viewPaths.today,
          icon: <Home size={18} strokeWidth={1.8} />,
        },
        {
          id: lastNutritionView,
          label: 'Nutrition',
          href: viewPaths[lastNutritionView],
          icon: <UtensilsCrossed size={18} strokeWidth={1.8} />,
        },
        {
          id: 'workouts' as const,
          label: 'Training',
          href: viewPaths.workouts,
          icon: <Dumbbell size={18} strokeWidth={1.8} />,
        },
      ],
    }),
    [view, lastNutritionView],
  );

  return (
    <Toaster toastManager={notifications} timeout={5500} viewportProps={{ className: 'corner-ui' }}>
      <>
        <AppSidebar
          id="corner-navigation"
          label="Corner navigation"
          brand={{ id: 'today', label: 'Corner home', href: viewPaths.today }}
          selectedId={view}
          onSelect={navigate}
          renderLink={({ href, ...props }) => <Link {...props} to={href!} />}
          groups={sidebarGroups}
          theme={theme}
          profile={{
            name: state.settings.name || displayName || 'Your workspace',
            initial: firstName.charAt(0).toUpperCase(),
            icon: <Settings2 size={16} />,
            label: `Open settings for ${state.settings.name || displayName || 'Your workspace'}`,
            selected: view === 'settings',
            href: viewPaths.settings,
            onSelect: () => navigate('settings'),
          }}
          note={preview ? 'Preview · changes stay in this session' : undefined}
          mobileNavigation={mobileNavigation}
        />
        <SidebarInset>
          <div className="workspace">
            {isMobile && (
              <WorkspaceMobileBar
                homeLabel="Corner home"
                onHome={() => navigate('today')}
                homeLink={<Link to={viewPaths.today} />}
                actions={
                  <>
                    <ThemePicker {...theme} compact />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="My agent"
                      title="My agent"
                      nativeButton={false}
                      role="link"
                      render={<Link to={viewPaths.agent} />}
                    >
                      <Sparkles size={18} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded-full p-0"
                      aria-label={`Open settings for ${state.settings.name || displayName || 'Your workspace'}`}
                      title={`Open settings for ${state.settings.name || displayName || 'Your workspace'}`}
                      nativeButton={false}
                      role="link"
                      render={<Link to={viewPaths.settings} />}
                    >
                      <Avatar size="sm">
                        <AvatarFallback>{firstName.charAt(0).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    </Button>
                  </>
                }
              />
            )}
            <div className="workspace-content scroll-fade" ref={workspaceContent}>
              {isMobile && preview && (
                <div className="ui-app-sidebar-note" role="status" style={{ marginBottom: 16 }}>
                  Preview · changes stay in this session
                </div>
              )}
              {isMobile && isNutritionView(view) && (
                <div className="nutrition-mobile-tabs">
                  <ToggleGroup
                    variant="outline"
                    value={[view]}
                    onValueChange={(values) => {
                      if (values[0]) navigate(values[0] as View);
                    }}
                    aria-label="Nutrition sections"
                  >
                    <ToggleGroupItem value="planner">Meal planner</ToggleGroupItem>
                    <ToggleGroupItem value="recipes">Recipes</ToggleGroupItem>
                    <ToggleGroupItem value="groceries">Grocery list</ToggleGroupItem>
                    <ToggleGroupItem value="studio">Recipe studio</ToggleGroupItem>
                  </ToggleGroup>
                </div>
              )}
              {view === 'today' && (
                <Today
                  state={state}
                  selectedDate={selectedDate}
                  setSelectedDate={setSelectedDate}
                  displayName={displayName}
                  disabled={disabled}
                  navigate={navigate}
                  mutate={mutate}
                  notify={notify}
                  setOverlay={setOverlay}
                  openRecipe={openRecipe}
                />
              )}

              {view === 'workouts' && (
                <TrainingPanel
                  state={state}
                  selectedDate={selectedDate}
                  onDateChange={setSelectedDate}
                  mutate={mutate}
                  busy={disabled}
                  notify={notify}
                  onRefresh={() => void readState()}
                  onOpenAgent={openAgent}
                />
              )}

              {view === 'agent' && (
                <>
                  <WorkspaceHeader
                    title="Your agent."
                    eyebrow="SUPPORT FOR THE PLAN YOU CHOOSE"
                    description="Practical suggestions, grounded in your own workspace."
                  />
                  <AgentPanel
                    state={state}
                    revision={revision}
                    referenceDate={selectedDate}
                    initialPrompt={agentPrompt}
                    onRefresh={() => void readState()}
                  />
                </>
              )}

              {view === 'planner' && (
                <MealPlanner
                  state={state}
                  selectedDate={selectedDate}
                  setSelectedDate={setSelectedDate}
                  disabled={disabled}
                  navigate={navigate}
                  mutate={mutate}
                  notify={notify}
                  setOverlay={setOverlay}
                  setConfirmation={setConfirmation}
                  openRecipe={openRecipe}
                  openAgent={openAgent}
                />
              )}

              {view === 'recipes' && (
                <RecipeCollection
                  state={state}
                  disabled={disabled}
                  navigate={navigate}
                  setOverlay={setOverlay}
                  openRecipe={openRecipe}
                  mutate={mutate}
                  filters={recipeFilters}
                />
              )}

              {view === 'groceries' && (
                <Groceries
                  state={state}
                  selectedDate={selectedDate}
                  setSelectedDate={setSelectedDate}
                  disabled={disabled}
                  navigate={navigate}
                  mutate={mutate}
                  copyText={copyText}
                />
              )}

              {view === 'studio' && (
                <RecipeStudio
                  state={state}
                  aiAvailable={aiAvailable}
                  disabled={disabled}
                  studio={studio}
                  navigate={navigate}
                  openAgent={openAgent}
                  openRecipe={openRecipe}
                  saveRecipe={saveRecipe}
                  copyText={copyText}
                />
              )}

              {view === 'settings' && (
                <Settings
                  state={state}
                  revision={revision}
                  disabled={disabled}
                  busy={busy}
                  preview={preview}
                  accountEmail={accountEmail}
                  signingOut={signingOut}
                  onSignOut={onSignOut}
                  notify={notify}
                  readState={readState}
                  mutate={mutate}
                />
              )}
            </div>
          </div>
        </SidebarInset>
        <WorkspaceOverlays
          state={state}
          selectedDate={selectedDate}
          disabled={disabled}
          busy={busy}
          aiAvailable={aiAvailable}
          overlay={overlay}
          setOverlay={setOverlay}
          confirmation={confirmation}
          setConfirmation={setConfirmation}
          mutate={mutate}
          saveRecipe={saveRecipe}
        />
      </>
    </Toaster>
  );
}
