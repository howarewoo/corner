'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Dumbbell, Home, Settings2, UtensilsCrossed } from 'lucide-react';
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
  WorkspaceMobileBar,
  type MobileNavigation,
} from '@packages/ui';
import TrainingPanel from './training-panel';
import { useActiveWorkout } from './active-workout';
import Today from '../features/today/today';
import MealPlanner from '../features/meal-planner/meal-planner';
import RecipeCollection, { useRecipeFilters } from '../features/recipes/recipe-collection';
import Groceries from '../features/groceries/groceries';
import Settings from '../features/settings/settings';
import WorkspaceOverlays from '../features/workspace/workspace-overlays';
import { useWorkspaceState } from '../features/workspace/use-workspace-state';
import { isNutritionView, sidebarGroups, viewPaths } from '../features/workspace/navigation';
import type { Confirmation, CornerAppProps, Overlay, View } from '../features/workspace/types';
import { useTheme } from '../theme';
import './training.css';

export default function CornerApp(props: CornerAppProps & { view: View }) {
  return (
    <SidebarProvider open mobileLayout="fullscreen" className="corner-ui">
      <CornerWorkspace {...props} />
    </SidebarProvider>
  );
}
function CornerWorkspace({
  initialState,
  initialSettings,
  preview,
  displayName,
  accountEmail,
  signingOut,
  onSignOut,
  view,
}: CornerAppProps & { view: View }) {
  const { isMobile } = useSidebar();
  const theme = useTheme();
  const [lastNutritionView, setLastNutritionView] = useState<'planner' | 'recipes' | 'groceries'>(
    isNutritionView(view) ? view : 'planner',
  );
  const workspaceContent = useRef<HTMLDivElement>(null);
  const routerNavigate = useNavigate();
  const router = useRouter();
  const [selectedDate, setSelectedDate] = useState(() =>
    dateKey(new Date(), (initialSettings ?? initialState!.settings).timezone),
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { state, settings, busy, disabled, notifications, notify, mutate, copyText } =
    useWorkspaceState({ initialState, initialSettings, preview });
  const activeWorkout = useActiveWorkout({
    state,
    accountKey: accountEmail ?? 'preview',
    busy: disabled,
    mutate,
    notify,
    view,
  });
  // Collection filters stay mounted with the workspace across navigation.
  const recipeFilters = useRecipeFilters();
  const resetNavigation = useCallback(() => {
    setOverlay(null);
    setConfirmation(null);
    workspaceContent.current?.scrollTo({ top: 0 });
    workspaceContent.current?.querySelector<HTMLElement>('h1')?.focus();
  }, []);
  useEffect(() => {
    if (isNutritionView(view)) setLastNutritionView(view);
    resetNavigation();
  }, [view, resetNavigation]);
  // A same-destination link resolves without changing TanStack's history key.
  useEffect(() => router.subscribe('onResolved', resetNavigation), [router, resetNavigation]);
  const navigate = (next: View) => {
    if (next !== view) void routerNavigate({ to: viewPaths[next], resetScroll: false });
  };
  const firstName = (settings.name || displayName || 'you').split(' ')[0];
  const openRecipe = (recipe: Recipe) => setOverlay({ kind: 'recipe', recipe });
  const saveRecipe = async (recipe: Recipe) => {
    if (await mutate({ type: 'recipe.save', data: recipe }, 'Recipe saved to your collection')) {
      setOverlay(null);
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
          renderLink={({ href, ...props }) => <Link {...props} to={href} resetScroll={false} />}
          groups={sidebarGroups}
          theme={theme}
          profile={{
            name: settings.name || displayName || 'Your workspace',
            initial: firstName.charAt(0).toUpperCase(),
            icon: <Settings2 size={16} />,
            label: `Open settings for ${settings.name || displayName || 'Your workspace'}`,
            selected: view === 'settings',
            href: viewPaths.settings,
            onSelect: () => navigate('settings'),
          }}
          note={preview ? 'Preview · changes stay in this session' : undefined}
          mobileNavigation={mobileNavigation}
        />
        <SidebarInset>
          <div className="workspace" data-active-workout={activeWorkout.hasActive || undefined}>
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
                      className="rounded-full p-0"
                      aria-label={`Open settings for ${settings.name || displayName || 'Your workspace'}`}
                      title={`Open settings for ${settings.name || displayName || 'Your workspace'}`}
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
                  settings={settings}
                  selectedDate={selectedDate}
                  onDateChange={setSelectedDate}
                  mutate={mutate}
                  busy={disabled}
                  notify={notify}
                  onActivateWorkout={activeWorkout.activate}
                />
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
                />
              )}

              {view === 'recipes' && (
                <RecipeCollection
                  state={state}
                  disabled={disabled}
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

              {view === 'settings' && (
                <Settings
                  state={state}
                  settings={settings}
                  disabled={disabled}
                  busy={busy}
                  preview={preview}
                  accountEmail={accountEmail}
                  signingOut={signingOut}
                  onSignOut={onSignOut}
                  notify={notify}
                  mutate={mutate}
                />
              )}
            </div>
          </div>
        </SidebarInset>
        {activeWorkout.surface}
        <WorkspaceOverlays
          state={state}
          selectedDate={selectedDate}
          disabled={disabled}
          busy={busy}
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
