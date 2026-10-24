"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useRoutes } from 'react-router';
import {
  Activity, ArrowDownToLine, ArrowRight, ArrowUpRight, CalendarDays, Check, CheckCircle2,
  ChevronLeft, ChevronRight, Circle, ClipboardList, Clock3, Copy, Dumbbell, Heart,
  Home, Leaf, Loader2, LogOut, Pencil, Plus, Search, Settings2,
  ShoppingBasket, Sparkles, Trash2, UtensilsCrossed, X,
} from 'lucide-react';
import type { AppState, FoodEntry, Ingredient, Macros, MealSlot, Mutation, PlanEntry, Recipe, RecipeCategory, RecipeRequest } from '@packages/shared/types';
import { SLOTS } from '@packages/shared/types';
import { activityForStateDate, applyMutation, dateKey, groceryList, macroTotal, mondayOf, shiftDate, targetForStateDate, weekDates } from '@packages/shared/domain';
import {
  Alert, AlertDescription, AppSidebar, Badge, Button, Card, Checkbox,
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Avatar, AvatarFallback,
  Dialog as SharedDialog, DialogContent, DialogHeader, DialogTitle,
  Empty as SharedEmpty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle,
  Input, InputGroup, InputGroupAddon, InputGroupInput, Label, NativeSelect, NativeSelectOption, Progress as SharedProgress,
  SidebarInset, SidebarProvider,
  Textarea, Toggle, ToggleGroup, ToggleGroupItem, createToastManager, Toaster, useSidebar,
  WorkspaceHeader, WorkspaceMobileBar,
  type MobileNavigation,
} from '@packages/ui';
import ProfileForm from '../profile-form';
import ImportWorkspace from '../import-workspace';
import AgentPanel, { AgentConnection } from '../agent-panel';
import TrainingPanel from './training-panel';
import MealPlannerSummary, { PlannerDayMacros } from './meal-planner-summary';
import FoodEstimator from './food-estimator';
import { foodEstimateToDraft, type EstimatedFood } from '@packages/shared/food-estimate';
import './training.css';
import './food-estimator.css';
import './food-entry.css';

type View = 'agent' | 'today' | 'workouts' | 'planner' | 'recipes' | 'groceries' | 'studio' | 'settings';
const viewPaths: Record<View, string> = {
  today: '/', agent: '/agent', workouts: '/workouts', planner: '/planner',
  recipes: '/recipes', groceries: '/groceries', studio: '/studio', settings: '/settings',
};
type Overlay = { kind: 'recipe'; recipe: Recipe } | { kind: 'recipeForm'; recipe?: Recipe } | { kind: 'food'; food?: FoodEntry } | { kind: 'pick'; date: string; slot: MealSlot; recipeId?: string } | null;
const isNutritionView = (v: View): v is 'planner' | 'recipes' | 'groceries' | 'studio' =>
  v === 'planner' || v === 'recipes' || v === 'groceries' || v === 'studio';
type ApiPayload = { state?: AppState; revision?: number; aiAvailable?: boolean; recipe?: Recipe; code?: string; error?: string | { message?: string; code?: string } };
const sidebarGroups = [
  { items: [
    { id: 'today' as const, label: 'Today', href: viewPaths.today, icon: <Home size={18} strokeWidth={1.8} /> },
    { id: 'agent' as const, label: 'My agent', href: viewPaths.agent, icon: <Sparkles size={18} strokeWidth={1.8} /> },
  ] },
  { label: 'Nutrition', items: [
    { id: 'planner' as const, label: 'Meal planner', href: viewPaths.planner, icon: <CalendarDays size={18} strokeWidth={1.8} /> },
    { id: 'recipes' as const, label: 'Recipes', href: viewPaths.recipes, icon: <UtensilsCrossed size={18} strokeWidth={1.8} /> },
    { id: 'groceries' as const, label: 'Grocery list', href: viewPaths.groceries, icon: <ShoppingBasket size={18} strokeWidth={1.8} /> },
    { id: 'studio' as const, label: 'Recipe studio', href: viewPaths.studio, icon: <UtensilsCrossed size={18} strokeWidth={1.8} /> },
  ] },
  { label: 'Training', items: [
    { id: 'workouts' as const, label: 'Workouts', href: viewPaths.workouts, icon: <Dumbbell size={18} strokeWidth={1.8} /> },
  ] },
];
const macroNames: Record<keyof Macros, string> = { calories: 'Calories', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' };
const num = (n: number, decimals = 0) => Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: decimals }) : '0';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const formatDate = (date: string, options: Intl.DateTimeFormatOptions) => new Date(`${date}T12:00:00`).toLocaleDateString('en-US', options);
const newId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const activityLabel = (activity: string) => /box/i.test(activity) ? 'Boxing day' : /lift|strength/i.test(activity) ? 'Strength day' : /rest|recover/i.test(activity) ? 'Recovery day' : cap(activity || 'Training');
const activityIcon = (activity: string) => /box/i.test(activity) ? Activity : /lift|strength/i.test(activity) ? Dumbbell : Leaf;
const zero: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };

function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & ComponentProps<typeof Button>) {
  return <Button variant="ghost" size="icon" aria-label={label} title={label} {...props}>{children}</Button>;
}
function Empty({ icon: Icon = UtensilsCrossed, title, children, action }: { icon?: typeof Home; title: string; children?: ReactNode; action?: ReactNode }) {
  return <SharedEmpty><EmptyHeader><EmptyMedia variant="icon"><Icon size={23} strokeWidth={1.5} /></EmptyMedia><EmptyTitle>{title}</EmptyTitle>{children && <EmptyDescription>{children}</EmptyDescription>}</EmptyHeader>{action && <EmptyContent>{action}</EmptyContent>}</SharedEmpty>;
}
function MacroLine({ nutrition, servings = 1 }: { nutrition: Macros; servings?: number }) {
  return <span className="macro-line"><b>{num(nutrition.calories * servings)} <span>kcal</span></b><span>{num(nutrition.protein * servings)}g P</span><span>{num(nutrition.carbs * servings)}g C</span><span>{num(nutrition.fat * servings)}g F</span></span>;
}
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <Label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</Label>;
}
function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <SharedDialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="corner-ui" style={wide ? { width: 'min(820px, calc(100vw - 32px))' } : undefined}><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>{children}</DialogContent></SharedDialog>;
}
function DateControls({ date, setDate, week = false }: { date: string; setDate: (date: string) => void; week?: boolean }) {
  const start = mondayOf(date);
  return <div className="date-control"><IconButton label={week ? 'Previous week' : 'Previous day'} onClick={() => setDate(shiftDate(date, week ? -7 : -1))}><ChevronLeft size={17} /></IconButton><span>{week ? `${formatDate(start, { month: 'short', day: 'numeric' })} – ${formatDate(shiftDate(start, 6), { month: 'short', day: 'numeric', year: 'numeric' })}` : formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' })}</span><IconButton label={week ? 'Next week' : 'Next day'} onClick={() => setDate(shiftDate(date, week ? 7 : 1))}><ChevronRight size={17} /></IconButton></div>;
}
function Progress({ value, target, label, targetsSet = true }: { value: number; target: number; label: string; targetsSet?: boolean }) {
  const pct = targetsSet && target > 0 ? Math.min(value / target * 100, 100) : 0;
  return <div className="macro-progress"><div className="macro-progress-heading"><span><i />{label}</span><b>{num(value)}<small>{targetsSet && target > 0 ? ` / ${num(target)} g` : ' g logged'}</small></b></div>{targetsSet && <SharedProgress value={pct} aria-label={label} />}</div>;
}

type CornerAppProps = { initialState: AppState; preview: boolean; displayName: string; initialRevision?: number; accountEmail?: string; signingOut?: boolean; onSignOut?: () => void; onSessionExpired?: () => void };
export default function CornerApp(props: CornerAppProps) {
  const routes = useRoutes([
    ...Object.entries(viewPaths).map(([view, path]) => ({
      path, element: <CornerWorkspace {...props} view={view as View} />,
    })),
    { path: '*', element: <Navigate to="/" replace /> },
  ]);
  return <SidebarProvider open mobileLayout="fullscreen" className="corner-ui">{routes}</SidebarProvider>;
}
function CornerWorkspace({ initialState, preview, displayName, initialRevision = 0, accountEmail, signingOut, onSignOut, onSessionExpired, view }: CornerAppProps & { view: View }) {
  const { isMobile } = useSidebar();
  const [lastNutritionView, setLastNutritionView] = useState<'planner' | 'recipes' | 'groceries' | 'studio'>(isNutritionView(view) ? view : 'planner');
  const workspaceContent = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<AppState>(initialState);
  const routerNavigate = useNavigate();
  const location = useLocation();
  const [agentPrompt, setAgentPrompt] = useState('');
  const [revision, setRevision] = useState(initialRevision);
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date(), initialState.settings.timezone));
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; confirm: () => Promise<boolean> } | null>(null);
  const [notifications] = useState(() => createToastManager());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!preview);
  const [hydrated, setHydrated] = useState(preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [studioPrompt, setStudioPrompt] = useState('');
  const [studioCalories, setStudioCalories] = useState(initialState.settings.training.calories > 0 ? Math.round(initialState.settings.training.calories / 4) : 500);
  const [studioProtein, setStudioProtein] = useState(initialState.settings.training.protein > 0 ? Math.round(initialState.settings.training.protein / 4) : 25);
  const [studioMinutes, setStudioMinutes] = useState(25);
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<Recipe | null>(null);
  const mutationLock = useRef(false);
  const refreshLock = useRef(false);
  const latestRevision = useRef(initialRevision);
  const generationLock = useRef(false);
  const generationIntent = useRef<{ signature: string; requestId: string } | null>(null);
  const notify = useCallback((message: string, error = false) => { notifications.add({ id: 'workspace-notice', title: message, type: error ? 'error' : 'success', priority: error ? 'high' : 'low' }); }, [notifications]);
  const readState = useCallback(async () => {
    if (preview || refreshLock.current || mutationLock.current) return;
    refreshLock.current = true;
    setLoading(true);
    try { const response = await fetch('/api/state', { cache: 'no-store' }); const payload = await response.json() as ApiPayload; if (response.status === 401 && payload.code === 'SIGN_IN_REQUIRED') { onSessionExpired?.(); return; } if (!response.ok || !payload.state) throw new Error(typeof payload.error === 'string' ? payload.error : 'Could not load your saved data. Please try again.'); if ((payload.revision ?? 0) >= latestRevision.current) { latestRevision.current = payload.revision ?? 0; setRevision(latestRevision.current); setState(payload.state); setAiAvailable(Boolean(payload.aiAvailable)); } setHydrated(true); setLoadError(null); }
    catch (error) { setLoadError(error instanceof Error ? error.message : 'Could not load your data.'); }
    finally { refreshLock.current = false; setLoading(false); }
  }, [preview, onSessionExpired]);
  useEffect(() => { void readState(); }, [readState]);
  useEffect(() => {
    const id = 'workspace-load-error';
    if (!loadError) { notifications.close(id); return; }
    notifications.add({
      id,
      title: hydrated ? 'Your latest data could not be refreshed.' : 'Your saved data could not be loaded.',
      description: hydrated ? loadError : 'Changes are paused until your saved data is available. Please retry.',
      type: 'error',
      priority: 'high',
      timeout: 0,
      actionProps: { children: loading ? 'Retrying…' : 'Retry', disabled: busy || loading, onClick: () => void readState() },
    });
  }, [loadError, hydrated, loading, busy, readState, notifications]);
  useEffect(() => {
    if (preview) return;
    const refresh = () => { if (document.visibilityState === 'visible') void readState(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [preview, readState]);
  const mutate = useCallback(async (mutation: Mutation, success?: string): Promise<boolean> => {
    if (!preview && !hydrated) { notify('Load your saved data before making changes. Use Retry to reconnect.', true); return false; }
    if (mutationLock.current) return false;
    mutationLock.current = true; setBusy(true);
    try {
      if (preview) setState(applyMutation(state, mutation));
      else {
        const response = await fetch('/api/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mutation, requestId: newId() }) });
        const payload = await response.json() as ApiPayload;
        if (response.status === 401 && payload.code === 'SIGN_IN_REQUIRED') { onSessionExpired?.(); return false; }
        if (!response.ok || !payload.state) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || 'Your change could not be saved. Please try again.');
        latestRevision.current = payload.revision ?? latestRevision.current; setRevision(latestRevision.current);
        setState(payload.state); setAiAvailable(Boolean(payload.aiAvailable)); setHydrated(true); setLoadError(null);
      }
      if (success) notify(success); return true;
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save your change.', true); return false; }
    finally { mutationLock.current = false; setBusy(false); }
  }, [preview, notify, state, hydrated, onSessionExpired]);
  const copyText = async (text: string, success = 'Copied to clipboard') => {
    try { await navigator.clipboard.writeText(text); notify(success); }
    catch { const textArea = document.createElement('textarea'); textArea.value = text; textArea.style.position = 'fixed'; textArea.style.opacity = '0'; document.body.appendChild(textArea); textArea.select(); let copied = false; try { copied = typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { copied = false; } finally { textArea.remove(); } notify(copied ? success : 'Copy is unavailable in this browser. Please use the download or try another browser.', !copied); }
  };
  useEffect(() => {
    if (isNutritionView(view)) setLastNutritionView(view);
    setOverlay(null);
    setConfirmation(null);
    workspaceContent.current?.scrollTo({ top: 0 });
    workspaceContent.current?.querySelector<HTMLElement>('h1')?.focus();
  }, [location.key, view]);
  const navigate = (next: View) => { if (next !== view) void routerNavigate(viewPaths[next]); };
  const openAgent = (prompt = '') => { setAgentPrompt(prompt); navigate('agent'); };
  const acceptAgentState = (payload: { state: AppState; revision: number; aiAvailable: boolean }) => { latestRevision.current = payload.revision; setRevision(payload.revision); setState(payload.state); setAiAvailable(payload.aiAvailable); };
  const targetsSet = state.settings.setup?.nutritionTargetsSet ?? (state.settings.training.calories > 0 && state.settings.rest.calories > 0);
  const currentDate = dateKey(new Date(), state.settings.timezone);
  const selectedActivity = activityForStateDate(state, selectedDate);
  const ActivityIcon = activityIcon(selectedActivity);
  const weekStart = mondayOf(selectedDate);
  const days = weekDates(weekStart);
  const dayPlan = state.plan.filter(entry => entry.date === selectedDate).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  const dayLogs = state.logs.filter(entry => entry.date === selectedDate).sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  const actual = macroTotal(dayLogs);
  const planned = macroTotal(dayPlan.flatMap(entry => { const recipe = state.recipes.find(r => r.id === entry.recipeId); return recipe ? [{ nutrition: recipe.nutrition, servings: entry.servings }] : []; }));
  const target = targetForStateDate(state, selectedDate);
  const groceries = useMemo(() => groceryList(state, weekStart), [state, weekStart]);
  const groceryGroups = useMemo(() => { const groups: Record<string, typeof groceries> = {}; groceries.forEach(item => { (groups[item.aisle || 'Other'] ||= []).push(item); }); return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)); }, [groceries]);
  const checkedGroceries = groceries.filter(item => state.groceryChecks[`${weekStart}|${item.key}`]).length;
  const filteredRecipes = state.recipes.filter(recipe => (!favoritesOnly || recipe.favorite) && (category === 'all' || recipe.category === category) && `${recipe.name} ${recipe.tags.join(' ')} ${recipe.ingredients.map(i => i.name).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const weekPlan = state.plan.filter(entry => days.includes(entry.date));
  const firstName = (state.settings.name || displayName || 'you').split(' ')[0];
  const disabled = busy || loading || !hydrated;
  const openRecipe = (recipe: Recipe) => setOverlay({ kind: 'recipe', recipe });
  const saveRecipe = async (recipe: Recipe) => { if (await mutate({ type: 'recipe.save', data: recipe }, 'Recipe saved to your collection')) { setOverlay(null); setGenerated(null); } };
  const logMeal = async (entry: PlanEntry) => {
    const recipe = state.recipes.find(r => r.id === entry.recipeId); if (!recipe) return;
    const alreadyLogged = state.logs.some(log => log.planEntryId === entry.id);
    if (alreadyLogged) { notify('This planned meal is already in your food log. Edit its portion in the log.'); return; }
    await mutate({ type: 'log.save', data: { id: newId(), date: entry.date, slot: entry.slot, name: recipe.name, nutrition: recipe.nutrition, servings: entry.servings, recipeId: recipe.id, planEntryId: entry.id, createdAt: new Date().toISOString() } }, 'Meal added to your food log');
  };
  const copyWeek = async () => {
    const previousDays = weekDates(shiftDate(weekStart, -7));
    const previous = state.plan.filter(entry => previousDays.includes(entry.date));
    if (!previous.length) { notify('There are no meals in the previous week to copy.'); return; }
    const mutation: Mutation = { type: 'plan.week', data: { weekStart, entries: previous.map(entry => ({ ...entry, id: newId(), date: shiftDate(entry.date, 7) })), replace: true } };
    if (weekPlan.length) {
      setConfirmation({ title: 'Replace this week’s plan?', description: 'Replace this week’s plan with the previous week? Your food log will stay as it is.', confirm: () => mutate(mutation, 'Previous week copied') });
      return;
    }
    await mutate(mutation, 'Previous week copied');
  };
  const groceryText = `CORNER · WEEKLY GROCERY LIST\n${formatDate(weekStart, { month: 'long', day: 'numeric', year: 'numeric' })}\n\n${groceryGroups.map(([aisle, items]) => `${aisle.toUpperCase()}\n${items.map(item => `${state.groceryChecks[`${weekStart}|${item.key}`] ? '[x]' : '[ ]'} ${item.name} — ${num(item.quantity, 2)} ${item.unit}${item.notes.length ? ` (${item.notes.join('; ')})` : ''}`).join('\n')}`).join('\n\n')}\n\nAmounts reflect the recipes and portions in your meal plan. Check your pantry and package sizes before shopping.`;
  const studioBrief = (request?: RecipeRequest) => `Recipe idea: ${request?.prompt || studioPrompt}\n\nPreferences: about ${request?.calories || studioCalories} calories, ${request?.protein || studioProtein} g protein per serving, ready in ${request?.maxMinutes || studioMinutes} minutes.\nDietary preferences: ${state.settings.profile?.dietaryPreferences || 'Not specified'}\nGroceries: ${state.settings.profile?.groceryPreferences || 'Not specified'}\nGoals: ${state.settings.profile?.goals || 'Not specified'}`;
  const saveRequest = async () => {
    if (!studioPrompt.trim()) { notify('Describe the recipe you want first.', true); return; }
    await mutate({ type: 'request.save', data: { id: newId(), prompt: studioPrompt.trim(), calories: studioCalories, protein: studioProtein, maxMinutes: studioMinutes, status: 'pending', createdAt: new Date().toISOString() } }, 'Recipe idea saved.');
  };
  const generateRecipe = async () => {
    if (generationLock.current) return;
    if (!studioPrompt.trim()) { notify('Describe the recipe you want first.', true); return; }
    if (!aiAvailable) { notify('Connect your AI account in My agent to generate a recipe.'); return; }
    if (studioPrompt.trim().length < 8 || studioPrompt.trim().length > 1600 || studioCalories < 150 || studioCalories > 1500 || studioProtein < 5 || studioProtein > 120 || studioMinutes < 5 || studioMinutes > 120) { notify('Describe your idea in at least 8 characters. Choose 150–1,500 calories, 5–120 g protein, and 5–120 minutes.', true); return; }
    const signature = JSON.stringify({ prompt: studioPrompt.trim(), calories: studioCalories, protein: studioProtein, maxMinutes: studioMinutes });
    if (generationIntent.current?.signature !== signature) generationIntent.current = { signature, requestId: newId() };
    const generationRequestId = generationIntent.current.requestId;
    generationLock.current = true; setGenerating(true);
    try { const response = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: studioPrompt.trim(), calories: studioCalories, protein: studioProtein, maxMinutes: studioMinutes, requestId: generationRequestId }) }); const payload = await response.json() as ApiPayload; if (!response.ok || !payload.recipe) { const code = payload.code || (typeof payload.error === 'object' ? payload.error?.code : undefined); if (!code?.endsWith('_PENDING') && code !== 'AI_BUSY' && code !== 'DAILY_LIMIT') generationIntent.current = null; throw new Error(payload.code === 'AI_NOT_CONFIGURED' || payload.error === 'AI_NOT_CONFIGURED' || (typeof payload.error === 'object' && payload.error?.code === 'AI_NOT_CONFIGURED') ? 'Connect your AI account in My agent to generate a recipe.' : typeof payload.error === 'string' ? payload.error : payload.error?.message || 'The recipe could not be generated. Please try again.'); } setGenerated(payload.recipe); generationIntent.current = null; }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not generate a recipe.', true); }
    finally { generationLock.current = false; setGenerating(false); }
  };
  const mobileNavigation = useMemo<MobileNavigation<View>>(() => ({
    label: 'Corner navigation',
    selectedId: isNutritionView(view) ? view : view === 'workouts' ? 'workouts' : 'today',
    items: [
      { id: 'today' as const, label: 'Home', href: viewPaths.today, icon: <Home size={18} strokeWidth={1.8} /> },
      { id: lastNutritionView, label: 'Nutrition', href: viewPaths[lastNutritionView], icon: <UtensilsCrossed size={18} strokeWidth={1.8} /> },
      { id: 'workouts' as const, label: 'Training', href: viewPaths.workouts, icon: <Dumbbell size={18} strokeWidth={1.8} /> },
    ],
  }), [view, lastNutritionView]);


  return <Toaster toastManager={notifications} timeout={5500} viewportProps={{ className: 'corner-ui' }}><>
    <AppSidebar
      id="corner-navigation" label="Corner navigation"
      brand={{ id: 'today', label: 'Corner home', href: viewPaths.today }}
      selectedId={view} onSelect={navigate}
      renderLink={({ href, ...props }) => <Link {...props} to={href!} />}
      groups={sidebarGroups}
      profile={{ name: state.settings.name || displayName || 'Your workspace', initial: firstName.charAt(0).toUpperCase(), icon: <Settings2 size={16} />, label: `Open settings for ${state.settings.name || displayName || 'Your workspace'}`, selected: view === 'settings', href: viewPaths.settings, onSelect: () => navigate('settings') }}
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
                onValueChange={values => {
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
        {view === 'today' && <>
          <WorkspaceHeader title={selectedDate === currentDate ? `In your corner, ${firstName}.` : formatDate(selectedDate, { month: 'long', day: 'numeric' })} actions={<><DateControls date={selectedDate} setDate={setSelectedDate} />{selectedDate !== currentDate && <Button variant="ghost" size="default" onClick={() => setSelectedDate(currentDate)}>Today</Button>}</>} />
          <div className="today-grid">
            <Card className="panel nutrition-panel"><div className="panel-heading"><div><h2>Today’s nutrition</h2><p>What you’ve logged, against your daily targets.</p></div><Badge variant="secondary" className="activity-badge"><ActivityIcon size={14} />{activityLabel(selectedActivity)}</Badge></div><div className="nutrition-main"><div className="calorie-ring"><svg viewBox="0 0 184 184" aria-hidden="true"><circle className="ring-track" cx="92" cy="92" r="76" /><circle className="ring-fill" cx="92" cy="92" r="76" strokeDasharray={`${(targetsSet ? Math.min(actual.calories / Math.max(target.calories, 1), 1) : 0) * 477.52} 477.52`} /></svg><div><span className="calorie-label">CALORIES LOGGED</span><strong>{num(actual.calories)}</strong><span>{targetsSet ? `of ${num(target.calories)} kcal` : 'Targets not set'}</span></div></div><div className="macro-progress-list"><Progress value={actual.protein} target={target.protein} label="Protein" targetsSet={targetsSet} /><Progress value={actual.carbs} target={target.carbs} label="Carbs" targetsSet={targetsSet} /><Progress value={actual.fat} target={target.fat} label="Fat" targetsSet={targetsSet} /></div></div><div className="nutrition-footer"><span><span className="tiny-dot" />{!targetsSet ? 'Set targets when you’re ready' : actual.calories <= target.calories ? `${num(target.calories - actual.calories)} kcal remaining` : `${num(actual.calories - target.calories)} kcal above target`}</span><Button variant="ghost" size="default" onClick={() => navigate('settings')}>{targetsSet ? 'Adjust targets' : 'Set targets'} <ArrowUpRight size={13} /></Button></div></Card>
            <section className="rhythm-panel"><div className="eyebrow">Your training week</div><h2 className="rhythm-current">{activityLabel(selectedActivity)}</h2><p>{formatDate(selectedDate, { weekday: 'long', month: 'short', day: 'numeric' })} · {selectedActivity}</p><ToggleGroup className="rhythm-days" aria-label="Training week day" value={[selectedDate]} onValueChange={values => { if (values[0]) setSelectedDate(String(values[0])); }}>{days.map(day => { const a = activityForStateDate(state, day), Icon = activityIcon(a); return <ToggleGroupItem value={day} key={day} aria-label={`${formatDate(day, { weekday: 'long' })}: ${activityLabel(a)}`} title={`${formatDate(day, { weekday: 'long' })}: ${activityLabel(a)}`}><span>{formatDate(day, { weekday: 'narrow' })}</span><i><Icon size={16} /></i></ToggleGroupItem>; })}</ToggleGroup><div className="rhythm-legend"><span><Activity size={13} />Conditioning</span><span><Dumbbell size={13} />Strength</span><span><Leaf size={13} />Recovery</span></div><Button variant="ghost" size="default" onClick={() => navigate('workouts')} className="rhythm-link">Open your workouts <ArrowRight size={16} /></Button></section>
          </div>
          <div className="today-bottom-grid"><Card className="panel meals-panel"><div className="panel-heading"><div><h2>On the menu</h2><p>{dayPlan.length ? `${dayPlan.length} meals · ${num(planned.calories)} kcal planned` : 'A little structure for the day ahead.'}</p></div><Button variant="ghost" size="sm" onClick={() => navigate('planner')}>Edit plan <ArrowUpRight size={14} /></Button></div>{dayPlan.length ? <div className="planned-meals">{dayPlan.map(entry => { const recipe = state.recipes.find(r => r.id === entry.recipeId); if (!recipe) return null; const logged = state.logs.some(log => log.planEntryId === entry.id); return <div className="planned-meal" key={entry.id}><span className={`meal-glyph ${recipe.category}`}><UtensilsCrossed size={18} strokeWidth={1.5} /></span><div className="planned-meal-info"><span className="mini-label">{cap(entry.slot)}</span><Button variant="link" size="default" onClick={() => openRecipe(recipe)} className="meal-name">{recipe.name}</Button><MacroLine nutrition={recipe.nutrition} servings={entry.servings} /></div><div className="planned-meal-actions"><Label className="portion-select"><span className="sr-only">Servings for {recipe.name}</span><NativeSelect aria-label={`Servings for ${recipe.name}`} value={entry.servings} disabled={disabled || logged} onChange={e => void mutate({ type: 'plan.save', data: { ...entry, servings: Number(e.target.value) } })}>{[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, ...( [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].includes(entry.servings) ? [] : [entry.servings])].sort((a,b) => a-b).map(n => <NativeSelectOption value={n} key={n}>{n}×</NativeSelectOption>)}</NativeSelect></Label><Button variant={logged ? 'secondary' : 'outline'} size="sm" disabled={disabled || logged} onClick={() => void logMeal(entry)}>{logged ? <Check size={14} /> : <Plus size={14} />}{logged ? 'Logged' : 'Log meal'}</Button></div></div>; })}</div> : <Empty title="Make room for a good meal" action={<Button variant="default" size="sm" onClick={() => setOverlay({ kind: 'pick', date: selectedDate, slot: 'breakfast' })}><Plus size={15} />Plan a meal</Button>}>Choose from your recipes and build a day that works for you.</Empty>}<div className="panel-footnote">Planned meals count toward your nutrition only when you log them.</div></Card>
          <Card className="panel food-log-panel"><div className="panel-heading"><div><h2>Food log</h2><p>{dayLogs.length ? `${dayLogs.length} ${dayLogs.length === 1 ? 'entry' : 'entries'} for this day` : 'A record of what you actually ate.'}</p></div><Button variant="ghost" size="sm" onClick={() => setOverlay({ kind: 'food' })}><Plus size={15} />Add food</Button></div>{dayLogs.length ? <div className="food-log-list">{dayLogs.map(log => <div key={log.id} className="food-log-row"><div><span className="mini-label">{cap(log.slot)} · {num(log.servings, 2)} serving{log.servings === 1 ? '' : 's'}</span><h3>{log.name}</h3><MacroLine nutrition={log.nutrition} servings={log.servings} /></div><div className="row-actions"><IconButton label={`Edit ${log.name}`} disabled={disabled} onClick={() => setOverlay({ kind: 'food', food: log })}><Pencil size={14} /></IconButton><IconButton label={`Delete ${log.name} from log`} disabled={disabled} onClick={() => void mutate({ type: 'log.delete', data: { id: log.id } }, 'Food entry removed')}><Trash2 size={14} /></IconButton></div></div>)}</div> : <Empty icon={ClipboardList} title="A fresh page" action={<Button variant="link" size="default" onClick={() => setOverlay({ kind: 'food' })}>Log your first meal <ArrowRight size={14} /></Button>}>Nothing logged yet. Add a planned meal or quickly enter something you ate.</Empty>}</Card></div>
        </>}

        {view === 'workouts' && <TrainingPanel state={state} selectedDate={selectedDate} onDateChange={setSelectedDate} mutate={mutate} busy={disabled} notify={notify} onRefresh={() => void readState()} onOpenAgent={openAgent} />}

        {view === 'agent' && <><WorkspaceHeader title="Your agent." eyebrow="SUPPORT FOR THE PLAN YOU CHOOSE" description="Practical suggestions, grounded in your own workspace." /><AgentPanel state={state} revision={revision} referenceDate={selectedDate} initialPrompt={agentPrompt} onApplied={acceptAgentState} onRefresh={() => void readState()} /></>}

        {view === 'planner' && <>
          <WorkspaceHeader title="Your meal plan." eyebrow="A WEEK WITH INTENTION" description="Build in variety. Leave a little room for life." actions={<><DateControls date={selectedDate} setDate={setSelectedDate} week /><Button variant="default" size="default" disabled={disabled} onClick={() => openAgent('Help me build a meal plan using my saved preferences. Ask for any details you need.')}><Sparkles size={16} />Plan with my agent</Button></>} />
          <div className="planner-toolbar"><div className="toolbar-description"><span className="status-dot" /><b>{weekPlan.length} planned meals</b><span>·</span><span>Portions update your grocery list automatically</span></div><Button variant="ghost" size="sm" disabled={disabled} onClick={() => void copyWeek()}><Copy size={15} />Copy previous week</Button></div>
          {!state.recipes.length && <div className="onboarding-nudge"><div><h3>Your first recipe starts the plan.</h3><p>Add a favorite manually, or create one with your connected agent.</p></div><Button variant="outline" size="default" onClick={() => setOverlay({ kind: 'recipeForm' })}><Plus size={16} />Add recipe</Button></div>}<MealPlannerSummary state={state} weekStart={weekStart} />
          <div className="planner-scroll"><div className="planner-grid">{days.map(day => { const a = activityForStateDate(state, day), Icon = activityIcon(a); const entries = state.plan.filter(entry => entry.date === day); const totals = macroTotal(entries.flatMap(entry => { const r = state.recipes.find(r => r.id === entry.recipeId); return r ? [{ nutrition: r.nutrition, servings: entry.servings }] : []; })); return <section className={`planner-day ${day === currentDate ? 'is-today' : ''}`} key={day}><div className="planner-day-heading"><div><span>{formatDate(day, { weekday: 'short' })}</span><strong>{formatDate(day, { day: 'numeric' })}</strong></div><Badge variant="secondary" className="planner-activity" title={activityLabel(a)}><Icon size={15} />{activityLabel(a).replace(' day', '')}</Badge></div><div className="planner-slots">{SLOTS.map(slot => <div className="planner-slot" key={slot}><div className="slot-label"><span>{cap(slot)}</span><Button variant="ghost" size="icon" aria-label={`Add ${slot} on ${formatDate(day, { weekday: 'long' })}`} disabled={disabled} onClick={() => setOverlay({ kind: 'pick', date: day, slot })}><Plus size={13} /></Button></div>{entries.filter(entry => entry.slot === slot).map(entry => { const recipe = state.recipes.find(r => r.id === entry.recipeId); if (!recipe) return null; return <div className={`plan-tile ${recipe.category}`} key={entry.id}><Button variant="ghost" size="default" onClick={() => openRecipe(recipe)} className="plan-tile-name">{recipe.name}</Button><div className="plan-tile-macros">{num(recipe.nutrition.calories * entry.servings)} kcal <span>· {num(recipe.nutrition.protein * entry.servings)}g P</span></div><div className="plan-tile-bottom"><Label><span className="sr-only">Servings for {recipe.name} on {day}</span><NativeSelect value={entry.servings} disabled={disabled} onChange={e => void mutate({ type: 'plan.save', data: { ...entry, servings: Number(e.target.value) } })}>{Array.from(new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, entry.servings])).sort((a,b)=>a-b).map(n => <NativeSelectOption value={n} key={n}>{n} serving{n === 1 ? '' : 's'}</NativeSelectOption>)}</NativeSelect></Label><Button variant="ghost" size="icon" aria-label={`Remove ${recipe.name} from ${day}`} disabled={disabled} onClick={() => void mutate({ type: 'plan.delete', data: { id: entry.id } })} className="tile-remove"><X size={13} /></Button></div></div>; })}{!entries.some(entry => entry.slot === slot) && <Button variant="ghost" size="default" disabled={disabled} onClick={() => setOverlay({ kind: 'pick', date: day, slot })} className="slot-empty"><Plus size={12} /><span>Add meal</span></Button>}</div>)}</div><PlannerDayMacros planned={totals} target={targetForStateDate(state, day)} targetsSet={targetsSet} /></section>; })}</div></div>
          <div className="planner-bottom-note"><span><ShoppingBasket size={17} />Your shopping list follows the plan, serving for serving.</span><Button variant="link" size="default" onClick={() => navigate('groceries')}>View grocery list <ArrowRight size={15} /></Button></div>
        </>}

        {view === 'recipes' && <>
          <WorkspaceHeader title="Your recipe collection." eyebrow="KEEP THE GOOD ONES" description="Reliable favorites, with enough variety to keep things interesting." actions={<><Button variant="outline" size="default" onClick={() => navigate('studio')}><Sparkles size={16} />Recipe studio</Button><Button variant="default" size="default" onClick={() => setOverlay({ kind: 'recipeForm' })}><Plus size={16} />New recipe</Button></>} />
          <div className="recipe-toolbar"><InputGroup><InputGroupAddon><Search size={17} /></InputGroupAddon><InputGroupInput aria-label="Search recipes" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recipes or ingredients…" /></InputGroup><ToggleGroup aria-label="Filter recipe category" value={[category]} onValueChange={values => { if (values[0]) setCategory(String(values[0])); }}>{[['all','All recipes'],['breakfast','Breakfast'],['main','Mains'],['snack','Snacks & fuel']].map(([key,label]) => <ToggleGroupItem key={key} value={key}>{label}</ToggleGroupItem>)}</ToggleGroup><Toggle pressed={favoritesOnly} onPressedChange={setFavoritesOnly} aria-label="Favorites"><Heart size={15} fill={favoritesOnly ? 'currentColor' : 'none'} />Favorites</Toggle></div>
          <div className="collection-meta"><span>{filteredRecipes.length} {filteredRecipes.length === 1 ? 'recipe' : 'recipes'}</span><span>Nutrition is approximate, per serving</span></div>
          {filteredRecipes.length ? <div className="recipe-grid">{filteredRecipes.map(recipe => <Card key={recipe.id} className="recipe-card"><div className={`recipe-card-top ${recipe.category}`}><Badge variant="secondary" className="recipe-category">{recipe.category === 'main' ? 'Main meal' : recipe.category === 'breakfast' ? 'Breakfast' : 'Snack & fuel'}</Badge><Button variant="ghost" size="icon" className={`favorite-button ${recipe.favorite ? 'is-favorite' : ''}`} aria-label={`${recipe.favorite ? 'Unfavorite' : 'Favorite'} ${recipe.name}`} disabled={disabled} onClick={() => void mutate({ type: 'recipe.favorite', data: { id: recipe.id, favorite: !recipe.favorite } })}><Heart size={17} fill={recipe.favorite ? 'currentColor' : 'none'} /></Button></div><Button variant="ghost" size="default" onClick={() => openRecipe(recipe)} className="recipe-card-main"><h2>{recipe.name}</h2><p>{recipe.description || 'An easy addition to your weekly rotation.'}</p><div className="recipe-card-tags"><span><Clock3 size={13} />{recipe.prepMinutes + recipe.cookMinutes} min</span>{recipe.tags.slice(0, 1).map(tag => <span key={tag}>{tag}</span>)}</div></Button><div className="recipe-card-bottom"><MacroLine nutrition={recipe.nutrition} /><Button variant="ghost" size="icon" aria-label={`View ${recipe.name}`} onClick={() => openRecipe(recipe)}><ArrowUpRight size={18} /></Button></div></Card>)}</div> : <Card className="panel"><Empty icon={Search} title="Nothing in this corner yet" action={<Button variant="outline" size="sm" onClick={() => { setSearch(''); setCategory('all'); setFavoritesOnly(false); }}>Clear filters</Button>}>Try another ingredient, or add a new recipe to your collection.</Empty></Card>}
        </>}

        {view === 'groceries' && <>
          <WorkspaceHeader title="Your grocery list." eyebrow="ONE TRIP. A BETTER WEEK." description="Everything your plan calls for, gathered in one place." actions={<><DateControls date={selectedDate} setDate={setSelectedDate} week /><Button variant="outline" size="default" disabled={!groceries.length} onClick={() => void copyText(groceryText, 'Grocery list copied')}><Copy size={16} />Copy list</Button></>} />
          <div className="grocery-layout"><div>{groceries.length ? <div className="grocery-groups">{groceryGroups.map(([aisle, items]) => <Card className="panel grocery-group" key={aisle}><div className="grocery-group-heading"><h2>{aisle}</h2><span>{items.length} items</span></div>{items.map(item => { const key = `${weekStart}|${item.key}`, checked = Boolean(state.groceryChecks[key]); return <Label className={`grocery-item ${checked ? 'checked' : ''}`} key={item.key}><Checkbox checked={checked} disabled={disabled} onCheckedChange={checked => void mutate({ type: 'grocery.check', data: { key, checked: Boolean(checked) } })} /><span className="grocery-item-description"><b>{item.name}</b>{item.notes.length > 0 && <small>{item.notes.join(' · ')}</small>}</span><strong>{num(item.quantity, 2)} <span>{item.unit}</span></strong></Label>; })}</Card>)}</div> : <Card className="panel"><Empty icon={ShoppingBasket} title="Your list starts with a plan" action={<Button variant="default" size="sm" onClick={() => navigate('planner')}>Build your meal plan <ArrowRight size={15} /></Button>}>Add recipes to this week’s planner, and their ingredients will appear here.</Empty></Card>}</div><aside className="grocery-summary"><span className="grocery-summary-icon"><ShoppingBasket size={29} strokeWidth={1.4} /></span><div className="eyebrow">This week’s shop</div><h2>Your shopping progress</h2><div className="shopping-progress"><div><span>In your basket</span><strong>{checkedGroceries}<small> / {groceries.length}</small></strong></div><SharedProgress value={groceries.length ? checkedGroceries / groceries.length * 100 : 0} aria-label="Shopping progress" /></div><div className="shopping-tips"><p><CheckCircle2 size={16} /><span>Check your pantry before you go. Quantities come from your planned portions.</span></p><p><CheckCircle2 size={16} /><span>Shop meat and seafood by raw weight, and grains by dry weight where noted.</span></p><p><CheckCircle2 size={16} /><span>Round up to available package sizes. Freeze later-week proteins and extra portions.</span></p></div><Button variant="outline" size="default" disabled={!groceries.length} onClick={() => download(groceryText, `corner-groceries-${weekStart}.txt`, 'text/plain')} className="full-width"><ArrowDownToLine size={16} />Download list</Button><Button variant="link" size="default" onClick={() => navigate('planner')}>Adjust the meal plan <ArrowRight size={14} /></Button></aside></div>
        </>}

        {view === 'studio' && <>
          <WorkspaceHeader title="Recipe studio." eyebrow="SOMETHING NEW FOR THE ROTATION" description="A craving, a few ingredients, a fresh idea. Start there." actions={<><Badge variant="secondary" className={`studio-status ${aiAvailable ? 'connected' : ''}`}><span className="status-dot" />{aiAvailable ? 'AI connection ready' : 'Connect AI to generate'}</Badge></>} />
          <div className="studio-layout"><div><Card className="panel studio-form"><div className="studio-intro-icon"><Sparkles size={23} /></div><h2>What sounds good?</h2><p>Tell us what you’re craving, what’s in the fridge, or what you’d like to change.</p><Field label="Your recipe idea"><Textarea value={studioPrompt} onChange={e => setStudioPrompt(e.target.value)} rows={5} maxLength={1600} placeholder="A flavorful dinner using what I have, easy to prep and suited to my food preferences…" /></Field><div className="suggestion-chips">{['A 20-minute high-protein dinner', 'A snack for a busy afternoon', 'Use up tofu and frozen vegetables'].map(idea => <Button variant="ghost" size="default" key={idea} onClick={() => setStudioPrompt(idea)}><Plus size={12} />{idea}</Button>)}</div><div className="studio-targets"><Field label="Calories per serving"><Input type="number" value={studioCalories} min={150} max={1500} step={25} onChange={e => setStudioCalories(Number(e.target.value))} /></Field><Field label="Protein goal (g)"><Input type="number" value={studioProtein} min={5} max={120} onChange={e => setStudioProtein(Number(e.target.value))} /></Field><Field label="Total time (min)"><Input type="number" value={studioMinutes} min={5} max={120} step={5} onChange={e => setStudioMinutes(Number(e.target.value))} /></Field></div>{!aiAvailable && <div className="connection-note"><Sparkles size={17} /><div><b>In-app generation needs an AI connection</b><p>Connect your AI account in My agent, or save the idea and add a recipe manually.</p></div></div>}<div className="studio-actions">{aiAvailable ? <Button variant="default" size="default" disabled={disabled || generating || !studioPrompt.trim()} onClick={() => void generateRecipe()}>{generating ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}{generating ? 'Creating your recipe…' : 'Create recipe'}</Button> : <Button variant="default" size="default" disabled={disabled || !studioPrompt.trim()} onClick={() => void saveRequest()}><Plus size={16} />Save recipe idea</Button>}<Button variant="outline" size="default" disabled={!studioPrompt.trim()} onClick={() => void copyText(studioBrief(), 'Recipe brief copied.')}><Copy size={16} />Copy brief</Button><Button variant="ghost" size="default" onClick={() => openAgent(studioBrief())}>Open my agent <ArrowUpRight size={15} /></Button></div></Card>
            {generated && <Card className="panel generated-recipe"><div className="panel-heading"><div><div className="eyebrow">YOUR NEW RECIPE · DRAFT</div><h2>{generated.name}</h2></div><Sparkles size={20} /></div><p>{generated.description}</p><MacroLine nutrition={generated.nutrition} /><p className="muted small-text">Review the ingredients and nutrition before adding this to your collection.</p><div className="button-row"><Button variant="outline" size="default" onClick={() => openRecipe(generated)}>Review recipe</Button><Button variant="default" size="default" disabled={disabled} onClick={() => void saveRecipe(generated)}><Plus size={16} />Save recipe</Button></div></Card>}
          </div><aside className="studio-aside"><div className="studio-tip"><span className="eyebrow">Your preferences</span><h2>Made for your routine.</h2><p>Recipe suggestions use the preferences you save in your profile.</p><div className="studio-preferences"><span><ShoppingBasket size={16} />{state.settings.profile?.groceryPreferences || 'Add your grocery preferences'}</span><span><UtensilsCrossed size={16} />{state.settings.profile?.dietaryPreferences || 'Add your food preferences'}</span><Button variant="link" size="default" onClick={() => navigate('settings')}>Edit profile <ArrowRight size={15} /></Button></div></div><div className="request-list"><div className="section-heading"><h2>Recipe requests</h2><span>{state.requests.length}</span></div>{state.requests.length ? state.requests.slice().reverse().map(request => <div className="request-item" key={request.id}><Badge variant="secondary" className={`request-status ${request.status}`}>{request.status === 'fulfilled' ? <Check size={12} /> : <Clock3 size={12} />}{cap(request.status)}</Badge><h3>{request.prompt}</h3><p>{request.calories} kcal · {request.protein}g protein · {request.maxMinutes} min</p>{request.status === 'fulfilled' && request.recipeId && state.recipes.find(r => r.id === request.recipeId) ? <Button variant="link" size="default" onClick={() => openRecipe(state.recipes.find(r => r.id === request.recipeId)!)}>View recipe <ArrowRight size={13} /></Button> : <Button variant="link" size="default" onClick={() => void copyText(studioBrief(request), 'Request brief copied')}>Copy request brief <Copy size={13} /></Button>}</div>) : <p className="muted request-empty">Your saved ideas will appear here. Keep a running list for your next meal prep.</p>}</div></aside></div>
        </>}

        {view === 'settings' && <><WorkspaceHeader title="Your starting point." eyebrow="MAKE IT YOURS" description="Targets that fit your routine, with room to adjust as you go." actions={<><Button variant="outline" size="default" onClick={() => download(JSON.stringify(state, null, 2), `corner-data-${currentDate}.json`, 'application/json')}><ArrowDownToLine size={16} />Export workspace</Button>{onSignOut && <Button variant="outline" disabled={signingOut || busy} onClick={onSignOut}><LogOut size={15} />{signingOut ? 'Signing out…' : 'Sign out'}</Button>}</>} /><p className="profile-help">Signed in as {accountEmail}</p><p className="profile-help" style={{ marginBottom: 24 }}>Workspace exports include recipes, plans, food and training logs, and your profile. Agent request history is not included.</p><ProfileForm key={revision} settings={state.settings} busy={disabled} onSave={settings => mutate({ type: 'settings.save', data: settings }, 'Your profile is saved')} /><ImportWorkspace disabled={disabled || preview} onImported={payload => { acceptAgentState(payload); notify('Your workspace is imported'); }} /><div style={{ marginTop: 32 }}><AgentConnection onChanged={() => void readState()} compact /></div></>}
        </div>
      </div>
    </SidebarInset>
    {overlay?.kind === 'recipe' && <RecipeDetail recipe={state.recipes.find(r => r.id === overlay.recipe.id) || overlay.recipe} busy={disabled} saved={state.recipes.some(r => r.id === overlay.recipe.id)} onClose={() => setOverlay(null)} onFavorite={recipe => void mutate({ type: 'recipe.favorite', data: { id: recipe.id, favorite: !recipe.favorite } })} onEdit={recipe => setOverlay({ kind: 'recipeForm', recipe })} onPlan={recipe => setOverlay({ kind: 'pick', date: selectedDate, slot: recipe.category === 'breakfast' ? 'breakfast' : recipe.category === 'snack' ? 'snack' : 'dinner', recipeId: recipe.id })} onSave={saveRecipe} onDelete={recipe => setConfirmation({ title: `Delete “${recipe.name}”?`, description: 'Remove any uses of this recipe from your meal plan first. Existing food log entries keep their nutrition.', confirm: async () => { const deleted = await mutate({ type: 'recipe.delete', data: { id: recipe.id } }, 'Recipe deleted'); if (deleted) setOverlay(null); return deleted; } })} />}
    {overlay?.kind === 'recipeForm' && <RecipeForm recipe={overlay.recipe} busy={disabled} onClose={() => setOverlay(null)} onSave={saveRecipe} />}
    {overlay?.kind === 'food' && <FoodForm food={overlay.food} date={selectedDate} busy={disabled} aiAvailable={aiAvailable} onClose={() => setOverlay(null)} onSave={async food => { if (await mutate({ type: 'log.save', data: food }, 'Food log saved')) setOverlay(null); }} />}
    {overlay?.kind === 'pick' && <RecipePicker recipes={state.recipes} date={overlay.date} slot={overlay.slot} initialRecipeId={overlay.recipeId} busy={disabled} onClose={() => setOverlay(null)} onAdd={async (recipe, date, slot, servings, entryId) => { if (await mutate({ type: 'plan.save', data: { id: entryId, date, slot, recipeId: recipe.id, servings } }, 'Meal added to your plan')) setOverlay(null); }} />}
    <AlertDialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) setConfirmation(null); }}><AlertDialogContent className="corner-ui"><AlertDialogHeader><AlertDialogTitle>{confirmation?.title}</AlertDialogTitle><AlertDialogDescription>{confirmation?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={async () => { if (confirmation && await confirmation.confirm()) setConfirmation(null); }}>{busy ? 'Saving…' : 'Confirm'}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </></Toaster>;
}

function ingredientAmount(ingredient: Ingredient, servings: number) {
  if (servings === 1 && ingredient.display) return ingredient.display;
  const qualifiers = Array.from(new Set((ingredient.display || '').match(/\b(?:cooked|raw|dry|drained)\b/gi) || [])).filter(qualifier => !ingredient.unit.toLowerCase().includes(qualifier.toLowerCase()));
  return `${num(ingredient.quantity * servings, 2)} ${ingredient.unit}${qualifiers.length ? ` ${qualifiers.join(', ').toLowerCase()}` : ''}`;
}

function RecipeDetail({ recipe, busy, saved, onClose, onFavorite, onEdit, onPlan, onSave, onDelete }: { recipe: Recipe; busy: boolean; saved: boolean; onClose: () => void; onFavorite: (recipe: Recipe) => void; onEdit: (recipe: Recipe) => void; onPlan: (recipe: Recipe) => void; onSave: (recipe: Recipe) => void; onDelete: (recipe: Recipe) => void }) {
  const [servings, setServings] = useState(1);
  const downloadRecipe = () => {
    const text = [
      recipe.name,
      recipe.description,
      `${recipe.prepMinutes} min prep · ${recipe.cookMinutes} min cook · ${num(servings, 2)} ${servings === 1 ? 'serving' : 'servings'}`,
      '',
      `ESTIMATED NUTRITION — TOTAL FOR ${num(servings, 2)} ${servings === 1 ? 'SERVING' : 'SERVINGS'}`,
      ...Object.entries(macroNames).map(([key, label]) => `${label}: ${num(recipe.nutrition[key as keyof Macros] * servings, 1)} ${key === 'calories' ? 'kcal' : 'g'}`),
      '',
      'INGREDIENTS',
      ...recipe.ingredients.map(ingredient => `- ${ingredientAmount(ingredient, servings)} ${ingredient.name}${ingredient.optional ? ' (optional)' : ''}${ingredient.note ? ` — ${ingredient.note}` : ''}`),
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
    const filename = recipe.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'recipe';
    download(text, `${filename}.txt`, 'text/plain;charset=utf-8');
  };
  return <Dialog title={recipe.name} onClose={onClose} wide><div className="recipe-detail"><div className="detail-topline"><Badge variant="secondary" className={`category-tag ${recipe.category}`}>{recipe.category === 'main' ? 'Main meal' : cap(recipe.category)}</Badge><span><Clock3 size={14} />{recipe.prepMinutes} min prep · {recipe.cookMinutes} min cook</span>{saved && <Button variant="link" size="default" disabled={busy} onClick={() => onFavorite(recipe)}><Heart size={15} fill={recipe.favorite ? 'currentColor' : 'none'} />{recipe.favorite ? 'Saved favorite' : 'Favorite'}</Button>}</div><p className="detail-description">{recipe.description}</p><div className="detail-macro-caption">Estimated nutrition · {servings === 1 ? 'Per serving' : `Total for ${num(servings, 2)} servings`}</div><div className="detail-macros">{Object.entries(macroNames).map(([key, label]) => <div key={key}><strong>{num(recipe.nutrition[key as keyof Macros] * servings)}<small>{key === 'calories' ? 'kcal' : 'g'}</small></strong><span>{label}</span></div>)}</div><div className="detail-section-heading"><h3>Ingredients</h3><div className="serving-stepper"><span>Servings</span><Button variant="ghost" size="default" type="button" disabled={servings <= 0.5} aria-label="Decrease servings" onClick={() => setServings(n => Math.max(0.5, n - 0.5))}>−</Button><Input aria-label="Recipe servings" type="number" min={0.25} max={20} step={0.25} value={servings} onChange={e => setServings(Math.min(20, Math.max(0.25, Number(e.target.value) || 0.25)))} /><Button variant="ghost" size="default" type="button" disabled={servings >= 20} aria-label="Increase servings" onClick={() => setServings(n => Math.min(20, n + 0.5))}>+</Button></div></div><ul className="ingredient-list">{recipe.ingredients.map((ingredient, index) => <li key={index}><span className="ingredient-bullet" /><span><b>{ingredient.name}</b>{ingredient.optional && <small> optional</small>}{ingredient.note && <small className="ingredient-note">{ingredient.note}</small>}</span><strong>{ingredientAmount(ingredient, servings)}{servings !== 1 && ingredient.display && <small className="ingredient-original">Per serving: {ingredient.display}</small>}</strong></li>)}</ul><h3 className="detail-section-title">Make it happen</h3><ol className="recipe-steps">{recipe.steps.map((step, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol>{recipe.storage && <div className="recipe-note"><h4><CalendarDays size={16} />Prep ahead & storage</h4><p>{recipe.storage}</p></div>}{recipe.variation && <div className="recipe-note variation-note"><h4><Sparkles size={16} />Keep it interesting</h4><p>{recipe.variation}</p></div>}<p className="nutrition-disclaimer">{servings !== 1 && <span>Nutrition above is the total for {num(servings, 2)} servings. </span>}{recipe.nutritionNote ? `${servings !== 1 ? 'Original recipe notes: ' : ''}${recipe.nutritionNote}` : 'Nutrition is an estimate. Check your product labels and actual portions. Values above scale with the servings selected.'}</p><div className="detail-actions"><div className="button-row">{saved ? <Button variant="default" size="default" onClick={() => onPlan(recipe)}><Plus size={15} />Add to meal plan</Button> : <Button variant="default" size="default" disabled={busy} onClick={() => onSave(recipe)}><Plus size={15} />Save recipe</Button>}{saved && <Button variant="outline" size="default" onClick={() => onEdit(recipe)}><Pencil size={14} />Edit</Button>}<Button variant="ghost" size="default" onClick={downloadRecipe}><ArrowDownToLine size={15} />Download recipe (.txt)</Button></div>{saved && <IconButton label="Delete recipe" disabled={busy} onClick={() => onDelete(recipe)}><Trash2 size={16} /></IconButton>}</div></div></Dialog>;
}

function RecipePicker({ recipes, date: initialDate, slot: initialSlot, initialRecipeId, busy, onClose, onAdd }: { recipes: Recipe[]; date: string; slot: MealSlot; initialRecipeId?: string; busy: boolean; onClose: () => void; onAdd: (recipe: Recipe, date: string, slot: MealSlot, servings: number, entryId: string) => void }) {
  const [query, setQuery] = useState('');
  const [entryId] = useState(newId);
  const [date, setDate] = useState(initialDate);
  const [slot, setSlot] = useState(initialSlot);
  const [servings, setServings] = useState(1);
  const [selected, setSelected] = useState<string | null>(initialRecipeId || null);
  const recipe = recipes.find(r => r.id === selected);
  const filtered = recipes.filter(r => r.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => { const preferred = slot === 'breakfast' ? 'breakfast' : ['snack', 'fuel'].includes(slot) ? 'snack' : 'main'; return Number(b.category === preferred) - Number(a.category === preferred); });
  return <Dialog title="Add a meal to your plan" onClose={onClose}><form className="dialog-form" onSubmit={e => { e.preventDefault(); if (recipe) onAdd(recipe, date, slot, servings, entryId); }}><div className="form-three"><Field label="Date"><Input type="date" required value={date} onChange={e => setDate(e.target.value)} /></Field><Field label="Meal"><NativeSelect value={slot} onChange={e => setSlot(e.target.value as MealSlot)}>{SLOTS.map(s => <NativeSelectOption key={s} value={s}>{cap(s)}</NativeSelectOption>)}</NativeSelect></Field><Field label="Servings"><Input type="number" required min={0.25} max={20} step={0.25} value={servings} onChange={e => setServings(Number(e.target.value))} /></Field></div><InputGroup><InputGroupAddon><Search size={17} /></InputGroupAddon><InputGroupInput aria-label="Find a recipe" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a recipe…" /></InputGroup><ToggleGroup className="recipe-picker-list" orientation="vertical" aria-label="Choose a recipe" value={selected ? [selected] : []} onValueChange={values => { if (values[0]) setSelected(String(values[0])); }}>{filtered.map(r => <ToggleGroupItem value={r.id} className="recipe-picker-item" type="button" key={r.id}><span className={`meal-glyph ${r.category}`}><UtensilsCrossed size={17} /></span><span><b>{r.name}</b><MacroLine nutrition={r.nutrition} servings={servings} /></span><span className="picker-check">{selected === r.id ? <CheckCircle2 size={18} /> : <Circle size={18} />}</span></ToggleGroupItem>)}{!filtered.length && <p className="muted">No matching recipes. Try another search.</p>}</ToggleGroup><div className="form-footer"><Button variant="outline" size="default" type="button" onClick={onClose}>Cancel</Button><Button variant="default" size="default" type="submit" disabled={busy || !recipe}><Plus size={15} />Add to plan</Button></div></form></Dialog>;
}

function MacroFields({ value, onChange }: { value: Macros; onChange: (value: Macros) => void }) {
  return <div className="macro-fields">{Object.entries(macroNames).map(([key, label]) => <Field label={`${label}${key === 'calories' ? ' (kcal)' : ' (g)'}`} key={key}><Input required type="number" min={0} max={key === 'calories' ? 10000 : key === 'carbs' ? 2500 : 1500} step="any" value={value[key as keyof Macros]} onChange={e => onChange({ ...value, [key]: Number(e.target.value) })} /></Field>)}</div>;
}
function FoodForm({ food, date, busy, aiAvailable, onClose, onSave }: { food?: FoodEntry; date: string; busy: boolean; aiAvailable: boolean; onClose: () => void; onSave: (food: FoodEntry) => void }) {
  const [entryId] = useState(() => food?.id || newId());
  const [createdAt] = useState(() => food?.createdAt || new Date().toISOString());
  const [name, setName] = useState(food?.name || '');
  const [nutrition, setNutrition] = useState<Macros>(food?.nutrition || { ...zero });
  const [servings, setServings] = useState(food?.servings || 1);
  const [foodDate, setFoodDate] = useState(food?.date || date);
  const [slot, setSlot] = useState<MealSlot>(food?.slot || 'snack');
  const [entryMode, setEntryMode] = useState<'describe' | 'manual'>(() => food || !aiAvailable ? 'manual' : 'describe');
  const [estimatedAmount, setEstimatedAmount] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const focusReview = useRef(false);
  useEffect(() => {
    if (entryMode === 'manual' && focusReview.current) {
      nameInput.current?.focus();
      focusReview.current = false;
    }
  }, [entryMode]);
  const useEstimate = (estimate: EstimatedFood) => {
    const draft = foodEstimateToDraft(estimate);
    setName(draft.name);
    setNutrition(draft.nutrition);
    setServings(draft.servings);
    setEstimatedAmount(estimate.amountSummary);
    focusReview.current = true;
    setEntryMode('manual');
  };
  return <Dialog title={food ? 'Edit food entry' : 'Add to your food log'} onClose={onClose}>
    {!food && <ToggleGroup aria-label="Food entry method" value={[entryMode]} onValueChange={values => { if (values[0]) setEntryMode(values[0] as 'describe' | 'manual'); }}>
      <ToggleGroupItem value="describe"><Sparkles size={16} />Describe food</ToggleGroupItem>
      <ToggleGroupItem value="manual"><Pencil size={16} />Enter manually</ToggleGroupItem>
    </ToggleGroup>}
    {!food && <div className="food-entry-mode-panel food-entry-description" hidden={entryMode !== 'describe'}>
      <FoodEstimator disabled={busy || entryMode !== 'describe'} aiAvailable={aiAvailable} onApply={useEstimate} />
    </div>}
    <div className="food-entry-mode-panel" hidden={entryMode !== 'manual'}>
      <form className="dialog-form" onSubmit={e => {
        e.preventDefault();
        if (busy || !name.trim()) return;
        onSave({ ...food, id: entryId, date: foodDate, slot, name: name.trim(), nutrition, servings, planEntryId: foodDate === food?.date ? food?.planEntryId : undefined, createdAt });
      }}>
        {estimatedAmount && <Alert variant="success" role="status"><CheckCircle2 size={17} /><AlertDescription>Estimate applied for <b>{estimatedAmount}</b>. Review or edit the values before saving.</AlertDescription></Alert>}
        <Field label="What did you eat?"><Input ref={nameInput} autoComplete="off" required maxLength={180} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Chicken sandwich" /></Field>
        <div className="form-three">
          <Field label="Date"><Input required type="date" value={foodDate} onChange={e => setFoodDate(e.target.value)} /></Field>
          <Field label="Meal"><NativeSelect value={slot} onChange={e => setSlot(e.target.value as MealSlot)}>{SLOTS.map(s => <NativeSelectOption key={s} value={s}>{cap(s)}</NativeSelectOption>)}</NativeSelect></Field>
          <Field label={estimatedAmount ? 'Portions eaten' : 'Servings eaten'} hint={estimatedAmount ? '1 = the full described amount' : undefined}><Input required type="number" min={0.25} max={20} step={0.25} value={servings} onChange={e => setServings(Number(e.target.value))} /></Field>
        </div>
        <div className="form-section-label">{estimatedAmount ? 'NUTRITION FOR THE DESCRIBED AMOUNT' : 'NUTRITION PER SERVING'}</div>
        <MacroFields value={nutrition} onChange={setNutrition} />
        <p className="form-help">{estimatedAmount ? 'This estimate covers the entire amount you described. Keep portions at 1 to log that amount, or change it to scale the entry. Check package labels when available.' : 'Use the package label or your best estimate. Your log will multiply these values by the servings eaten.'}</p>
        <div className="food-total-preview"><span>This entry adds</span><MacroLine nutrition={nutrition} servings={servings} /></div>
        <div className="form-footer"><Button variant="outline" size="default" type="button" onClick={onClose}>Cancel</Button><Button variant="default" size="default" disabled={busy || !name.trim()} type="submit">{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save food entry</Button></div>
      </form>
    </div>
  </Dialog>;
}
function RecipeForm({ recipe, busy, onClose, onSave }: { recipe?: Recipe; busy: boolean; onClose: () => void; onSave: (recipe: Recipe) => void }) {
  const [recipeId] = useState(() => recipe?.id || newId());
  const [createdAt] = useState(() => recipe?.createdAt || new Date().toISOString());
  const [name, setName] = useState(recipe?.name || '');
  const [description, setDescription] = useState(recipe?.description || '');
  const [category, setCategory] = useState<RecipeCategory>(recipe?.category || 'main');
  const [prep, setPrep] = useState(recipe?.prepMinutes || 10);
  const [cook, setCook] = useState(recipe?.cookMinutes || 15);
  const [nutrition, setNutrition] = useState<Macros>(recipe?.nutrition || { ...zero });
  const [ingredients, setIngredients] = useState(recipe?.ingredients.map(i => `${i.quantity} | ${i.unit} | ${i.name} | ${i.aisle}${i.note ? ` | ${i.note}` : ''}`).join('\n') || '');
  const [steps, setSteps] = useState(recipe?.steps.join('\n') || '');
  const [storage, setStorage] = useState(recipe?.storage || '');
  const [variation, setVariation] = useState(recipe?.variation || '');
  const [formError, setFormError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault(); setFormError('');
    const parsed: Ingredient[] = [];
    for (const line of ingredients.split('\n').filter(s => s.trim())) {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length < 3 || !parts[0] || !Number.isFinite(Number(parts[0])) || Number(parts[0]) <= 0 || !parts[1] || !parts[2]) { setFormError('Please enter each ingredient as quantity | unit | ingredient | aisle. Example: 150 | g | chicken breast, raw | Meat & seafood'); return; }
      const existing = recipe?.ingredients.find(i => i.name === parts[2]);
      parsed.push({ name: parts[2], quantity: Number(parts[0]), unit: parts[1], aisle: parts[3] || 'Other', note: parts[4] || undefined, ...(existing && existing.quantity === Number(parts[0]) && existing.unit === parts[1] ? { shoppingQuantity: existing.shoppingQuantity, shoppingUnit: existing.shoppingUnit, optional: existing.optional, display: existing.display } : {}) });
    }
    if (!parsed.length || !steps.trim()) { setFormError('Add at least one ingredient and one cooking step.'); return; }
    onSave({ ...recipe, id: recipeId, name: name.trim(), description: description.trim(), category, prepMinutes: prep, cookMinutes: cook, nutrition, ingredients: parsed, steps: steps.split('\n').map(s => s.trim()).filter(Boolean), storage: storage.trim(), variation: variation.trim(), tags: recipe?.tags || ['My recipe'], color: recipe?.color || '#e8eee1', source: recipe?.source || 'manual', favorite: recipe?.favorite || false, createdAt, nutritionNote: recipe?.nutritionNote || 'Nutrition entered manually. Check package labels and portions for the best estimate.' });
  };
  return <Dialog title={recipe ? 'Edit recipe' : 'Add a new recipe'} onClose={onClose} wide><form className="dialog-form" onSubmit={submit}><Field label="Recipe name"><Input required maxLength={160} value={name} onChange={e => setName(e.target.value)} placeholder="Give this one a name" /></Field><Field label="A little about it"><Input maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="What makes this a good addition to your rotation?" /></Field><div className="form-three"><Field label="Category"><NativeSelect value={category} onChange={e => setCategory(e.target.value as RecipeCategory)}><NativeSelectOption value="breakfast">Breakfast</NativeSelectOption><NativeSelectOption value="main">Main meal</NativeSelectOption><NativeSelectOption value="snack">Snack & fuel</NativeSelectOption></NativeSelect></Field><Field label="Prep time (min)"><Input required type="number" min={0} max={1440} value={prep} onChange={e => setPrep(Number(e.target.value))} /></Field><Field label="Cook time (min)"><Input required type="number" min={0} max={1440} value={cook} onChange={e => setCook(Number(e.target.value))} /></Field></div><div className="form-section-label">NUTRITION & INGREDIENTS FOR ONE SERVING</div><MacroFields value={nutrition} onChange={setNutrition} /><Field label="Ingredients" hint="One per line: quantity | unit | ingredient | aisle | optional note. Use raw meat and dry grain weights for easy shopping."><Textarea required rows={5} value={ingredients} onChange={e => setIngredients(e.target.value)} placeholder={'150 | g | Chicken breast, raw | Meat & seafood\n75 | g | Rice, dry | Pantry\n1 | tbsp | Olive oil | Pantry'} /></Field><Field label="Cooking steps" hint="Put each step on a new line."><Textarea required rows={5} value={steps} onChange={e => setSteps(e.target.value)} placeholder={'Cook the rice according to the package instructions.\nSeason and cook the chicken, then slice.'} /></Field><Field label="Prep ahead & storage"><Textarea rows={2} value={storage} onChange={e => setStorage(e.target.value)} placeholder="How to store or freeze leftovers" /></Field><Field label="A variation"><Textarea rows={2} value={variation} onChange={e => setVariation(e.target.value)} placeholder="A swap that keeps it interesting" /></Field>{formError && <Alert variant="destructive"><AlertDescription>{formError}</AlertDescription></Alert>}<div className="form-footer"><Button variant="outline" size="default" type="button" onClick={onClose}>Cancel</Button><Button variant="default" size="default" type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save recipe</Button></div></form></Dialog>;
}
