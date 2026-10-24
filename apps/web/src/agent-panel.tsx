import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Link2,
  Loader2,
  RefreshCw,
  Sparkles,
  Square,
  Unplug,
} from 'lucide-react';
import type { AgentChange, AgentRun } from '@packages/shared/agent';
import type { AppState, Macros, Recipe, StateResponse } from '@packages/shared/types';
import type {
  ExerciseTarget,
  WorkoutSession,
  WorkoutTemplate,
} from '@packages/shared/training-types';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from '@packages/ui';
import { api, errorMessage, post } from './api';
import './agent.css';
type Connection = {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  state?: string;
  reason?: string;
  model: string | null;
  models: Array<{ slug: string; displayName: string }>;
  email?: string;
  manageUsageUrl?: string | null;
};
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const when = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
const isActive = (run: AgentRun) => run.status === 'running';
function latestRun(current: AgentRun | undefined, incoming: AgentRun): AgentRun {
  if (!current) return incoming;
  if (current.status === 'applied' && incoming.status !== 'applied') return current;
  if (current.status !== 'running' && incoming.status === 'running') return current;
  return incoming.updatedAt >= current.updatedAt ? incoming : current;
}

export function AgentConnection({
  onChanged,
  compact = false,
}: {
  onChanged?: () => void;
  compact?: boolean;
}) {
  const modelSelectId = useId();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [actionNotice, setActionNotice] = useState<{ message: string; warning: boolean } | null>(
    null,
  );
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const result = await api<Connection>('/api/ai/connection');
      if (current === sequence.current) {
        setConnection(result);
        onChangedRef.current?.();
      }
    } catch (failure) {
      if (current === sequence.current) setError(errorMessage(failure));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  async function connect() {
    if (busy) return;
    const current = sequence.current;
    setBusy(true);
    setError('');
    setActionNotice(null);
    try {
      const result = await post<{ url: string }>('/api/ai/connect', {});
      if (current !== sequence.current) return;
      const destination = new URL(result.url, window.location.origin);
      if (!['https:', 'http:'].includes(destination.protocol))
        throw new Error('The sign-in link is unavailable. Please try again.');
      window.location.assign(destination.href);
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await post<{ revocationConfirmed?: boolean; reason?: string }>(
        '/api/ai/disconnect',
        {},
      );
      await refresh();
      setActionNotice({
        warning: result?.revocationConfirmed === false,
        message:
          result?.reason ||
          (result?.revocationConfirmed === false
            ? 'The local connection was removed, but remote access revocation could not be confirmed. You can manage the connection in your ChatGPT settings.'
            : 'Your AI connection was removed.'),
      });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  async function changeModel(model: string) {
    if (!model || busy) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/ai/model', { model });
      await refresh();
      setActionNotice({ message: 'Model selection saved.', warning: false });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const ready = Boolean(connection?.available && connection.connected && connection.enabled);
  const reconnect = Boolean(connection?.connected && connection.enabled && !ready);
  return (
    <section
      className={`agent-connection corner-ui ${compact ? 'agent-connection-compact' : ''}`}
      aria-label="Agent connection"
    >
      <div className="agent-connection-heading">
        <span>
          <Link2 size={18} />
          Your AI connection
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="Refresh AI connection"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </Button>
      </div>
      <p className="agent-connection-status" role="status">
        {loading
          ? 'Checking connection…'
          : ready
            ? 'Connected and ready'
            : connection?.connected
              ? 'Connected · action needed'
              : connection?.enabled
                ? 'Connect to use the agent'
                : 'Agent unavailable'}
      </p>
      {connection?.email && <p className="agent-account-email">{connection.email}</p>}
      <p>
        {connection?.reason ||
          (ready
            ? 'Requests use your selected connection. Review proposed changes before applying them.'
            : 'Your plans and tracking work independently. Connect when you want help creating or adapting a plan.')}
      </p>
      {connection && connection.models.length > 0 && (
        <Field className="field">
          <FieldLabel htmlFor={modelSelectId}>Model</FieldLabel>
          <NativeSelect
            id={modelSelectId}
            name="model"
            disabled={busy || loading || !connection.connected}
            value={connection.model ?? ''}
            onChange={(event) => void changeModel(event.target.value)}
          >
            <NativeSelectOption value="" disabled>
              Choose a model
            </NativeSelectOption>
            {connection.models.map((model) => (
              <NativeSelectOption key={model.slug} value={model.slug}>
                {model.displayName}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      <div className="button-row">
        {(!connection?.connected || reconnect) && (
          <Button
            type="button"
            variant="default"
            disabled={busy || loading || !connection?.enabled}
            onClick={() => void connect()}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />}
            {busy
              ? 'Opening sign-in…'
              : reconnect
                ? 'Reconnect with ChatGPT'
                : 'Continue with ChatGPT'}
          </Button>
        )}
        {connection?.connected && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || loading}
            onClick={() => void disconnect()}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Unplug size={15} />}Disconnect
          </Button>
        )}
      </div>
      {connection?.enabled && (
        <p className="agent-connection-help">
          After linking an account, reconnecting uses the same ChatGPT identity.
        </p>
      )}
      {connection?.manageUsageUrl && /^https:\/\//.test(connection.manageUsageUrl) && (
        <a
          className="text-link inline-link"
          href={connection.manageUsageUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Manage AI usage <ArrowRight size={14} />
        </a>
      )}
      {error && (
        <Alert variant="destructive" className="form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {actionNotice && (
        <Alert
          variant={actionNotice.warning ? 'warning' : 'success'}
          className={`agent-action-notice ${actionNotice.warning ? 'is-warning' : ''}`}
        >
          <AlertDescription>
            {actionNotice.message}
            {actionNotice.warning && (
              <a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">
                Open ChatGPT settings <ArrowRight size={13} />
              </a>
            )}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function Nutrition({ value, label }: { value: Macros; label?: string }) {
  return (
    <div className="agent-nutrition">
      {label && <h5>{label}</h5>}
      <dl>
        {(['calories', 'protein', 'carbs', 'fat'] as const).map((key) => (
          <div key={key}>
            <dt>{key === 'calories' ? 'Calories' : key.charAt(0).toUpperCase() + key.slice(1)}</dt>
            <dd>
              {number(value[key])}
              <span>{key === 'calories' ? 'kcal' : 'g'}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function ExerciseList({ exercises, unit }: { exercises: ExerciseTarget[]; unit?: string }) {
  return (
    <ol className="agent-exercises">
      {exercises.map((exercise) => (
        <li key={exercise.id}>
          <div>
            <b>{exercise.name}</b>
            <span>
              {exercise.targetSets} sets ×{' '}
              {exercise.repMin === exercise.repMax
                ? exercise.repMin
                : `${exercise.repMin}–${exercise.repMax}`}{' '}
              reps{exercise.targetRir !== null ? ` · ${exercise.targetRir} RIR` : ' · RIR not set'}{' '}
              · {exercise.restSeconds}s rest
            </span>
            <small>
              {exercise.loadType === 'per_hand'
                ? 'Load per hand'
                : exercise.loadType === 'bodyweight'
                  ? 'Bodyweight'
                  : exercise.loadType === 'assistance'
                    ? 'Assistance load'
                    : 'Total load'}
              {exercise.targetLoad
                ? ` · ${number(exercise.targetLoad.weight)} ${exercise.targetLoad.unit}`
                : unit
                  ? ` · ${unit}, load not set`
                  : ''}
            </small>
          </div>
          {exercise.notes && <p>{exercise.notes}</p>}
        </li>
      ))}
    </ol>
  );
}
function WorkoutPreview({ workout }: { workout: WorkoutSession | WorkoutTemplate }) {
  const session = 'date' in workout;
  return (
    <div className="agent-workout-preview">
      <h4>{workout.name}</h4>
      <p>
        {session ? `${workout.date} · ` : 'Reusable routine · '}
        {workout.kind} · {session ? workout.plannedMinutes : workout.durationMinutes} minutes
      </p>
      {workout.exercises.length > 0 && (
        <ExerciseList exercises={workout.exercises} unit={session ? workout.unit : undefined} />
      )}
      {session
        ? workout.notes && <p className="agent-detail-text">{workout.notes}</p>
        : workout.description && <p className="agent-detail-text">{workout.description}</p>}
    </div>
  );
}
function ChangePreview({
  change,
  state,
  recipes,
}: {
  change: AgentChange;
  state: AppState;
  recipes: Map<string, Recipe>;
}) {
  let body: React.ReactNode;
  if (change.type === 'recipe') {
    const recipe = change.data;
    const previous = state.recipes.find((item) => item.id === recipe.id);
    body = (
      <>
        <h4>{recipe.name}</h4>
        <p>{recipe.description}</p>
        {previous && <Nutrition value={previous.nutrition} label="Current · per serving" />}
        <Nutrition value={recipe.nutrition} label="Proposed · per serving" />
        <p>
          {recipe.prepMinutes} min prep · {recipe.cookMinutes} min cook · {recipe.category}
        </p>
        <Collapsible className="agent-recipe-details">
          <CollapsibleTrigger className="agent-recipe-summary">
            <span>Ingredients, steps & storage</span>
            <ChevronDown size={15} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul>
              {recipe.ingredients.map((ingredient, index) => (
                <li key={index}>
                  <b>{ingredient.display || `${number(ingredient.quantity)} ${ingredient.unit}`}</b>{' '}
                  {ingredient.name}
                  {ingredient.note && <small> — {ingredient.note}</small>}
                  {ingredient.optional && <small> · optional</small>}
                </li>
              ))}
            </ul>
            <ol>
              {recipe.steps.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            {recipe.storage && (
              <p>
                <b>Storage:</b> {recipe.storage}
              </p>
            )}
            {recipe.variation && (
              <p>
                <b>Variation:</b> {recipe.variation}
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
      </>
    );
  } else if (change.type === 'meal') {
    const meal = change.data,
      recipe = recipes.get(meal.recipeId),
      previous = state.plan.find((item) => item.id === meal.id);
    body = (
      <>
        <h4>{recipe?.name || 'Recipe from this proposal'}</h4>
        {previous && (
          <p className="agent-previous">
            Current:{' '}
            {state.recipes.find((item) => item.id === previous.recipeId)?.name || 'Saved recipe'} ·{' '}
            {previous.date} · {previous.slot} · {number(previous.servings)} servings
          </p>
        )}
        <p>
          <b>
            {meal.date} · {meal.slot}
          </b>{' '}
          · {number(meal.servings)} servings
        </p>
        {recipe && (
          <Nutrition
            value={{
              calories: recipe.nutrition.calories * meal.servings,
              protein: recipe.nutrition.protein * meal.servings,
              carbs: recipe.nutrition.carbs * meal.servings,
              fat: recipe.nutrition.fat * meal.servings,
            }}
            label="Planned nutrition"
          />
        )}
      </>
    );
  } else if (change.type === 'workout' || change.type === 'routine') {
    const previous =
      change.type === 'workout'
        ? state.training.sessions.find((item) => item.id === change.data.id)
        : state.training.templates.find((item) => item.id === change.data.id);
    body = (
      <>
        {previous && (
          <Collapsible className="agent-previous">
            <CollapsibleTrigger className="agent-previous-summary">
              <span>Compare with current {change.type}</span>
              <ChevronDown size={14} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <WorkoutPreview workout={previous} />
            </CollapsibleContent>
          </Collapsible>
        )}
        <WorkoutPreview workout={change.data} />
      </>
    );
  } else if (change.type === 'targets') {
    body = (
      <div className="agent-target-comparison">
        <div>
          <h4>Training days</h4>
          <Nutrition value={state.settings.training} label="Current" />
          <Nutrition value={change.data.training} label="Proposed" />
        </div>
        <div>
          <h4>Recovery days</h4>
          <Nutrition value={state.settings.rest} label="Current" />
          <Nutrition value={change.data.rest} label="Proposed" />
        </div>
      </div>
    );
  } else if (change.type === 'remove_meal') {
    const meal = state.plan.find((item) => item.id === change.data.id);
    body = (
      <div>
        <h4>Remove a planned meal</h4>
        <p>
          {meal
            ? `${recipes.get(meal.recipeId)?.name || meal.recipeId} · ${meal.date} · ${meal.slot} · ${number(meal.servings)} servings`
            : 'This planned meal is no longer in the workspace.'}
        </p>
      </div>
    );
  } else {
    const workout = state.training.sessions.find((item) => item.id === change.data.id);
    body = (
      <div>
        <h4>Remove a planned workout</h4>
        {workout ? (
          <WorkoutPreview workout={workout} />
        ) : (
          <p>This planned workout is no longer in the workspace.</p>
        )}
      </div>
    );
  }
  return (
    <article className="agent-change">
      <div className="agent-change-heading">
        <Badge variant="outline" className="agent-change-type">
          {change.type.replaceAll('_', ' ')}
        </Badge>
        <h3>{change.label}</h3>
        <p>{change.reason}</p>
      </div>
      <div className="agent-change-content">{body}</div>
    </article>
  );
}

export default function AgentPanel({
  state,
  revision,
  referenceDate,
  initialPrompt = '',
  onApplied,
  onRefresh,
}: {
  state: AppState;
  revision: number;
  referenceDate: string;
  initialPrompt?: string;
  onApplied: (payload: StateResponse) => void;
  onRefresh: () => void;
}) {
  const promptId = useId();
  const dateId = useId();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [date, setDate] = useState(referenceDate);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState<Connection | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const operation = useRef(false);
  const intent = useRef<{ signature: string; id: string } | null>(null);
  const appliedIntent = useRef(new Map<string, string>());
  const active = useRef(true);
  const refreshSequence = useRef(0);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const ready = Boolean(connection?.available && connection.connected && connection.enabled);
  const refresh = useCallback(async () => {
    if (!active.current) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    setError('');
    try {
      const [history, currentConnection] = await Promise.all([
        api<{ runs: AgentRun[] }>('/api/agent/runs'),
        api<Connection>('/api/ai/connection'),
      ]);
      if (!active.current || sequence !== refreshSequence.current) return;
      setRuns((current) =>
        history.runs.map((run) =>
          latestRun(
            current.find((item) => item.id === run.id),
            run,
          ),
        ),
      );
      setConnection(currentConnection);
    } catch (failure) {
      if (active.current && sequence === refreshSequence.current) setError(errorMessage(failure));
    } finally {
      if (active.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      refreshSequence.current += 1;
    };
  }, [refresh]);
  useEffect(() => {
    if (initialPrompt) {
      setPrompt(initialPrompt);
      intent.current = null;
      textarea.current?.focus();
    }
  }, [initialPrompt]);
  const runningIds = runs
    .filter(isActive)
    .map((run) => run.id)
    .join('|');
  useEffect(() => {
    if (!runningIds) return;
    let pending = false;
    const controller = new AbortController();
    const timer = window.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const updated = await Promise.all(
          runningIds
            .split('|')
            .map((id) =>
              api<{ run: AgentRun }>(`/api/agent/runs/${encodeURIComponent(id)}`, {
                signal: controller.signal,
              }),
            ),
        );
        if (!controller.signal.aborted)
          setRuns((current) =>
            current.map((run) => {
              const incoming = updated.find((item) => item.run.id === run.id)?.run;
              return incoming ? latestRun(run, incoming) : run;
            }),
          );
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        pending = false;
      }
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [runningIds]);
  async function start(event: FormEvent) {
    event.preventDefault();
    if (operation.current || !ready || prompt.trim().length < 3) return;
    operation.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify([prompt.trim(), date]);
    if (intent.current?.signature !== signature)
      intent.current = { signature, id: crypto.randomUUID() };
    try {
      const result = await post<{ run: AgentRun }>('/api/agent/runs', {
        requestId: intent.current.id,
        prompt: prompt.trim(),
        referenceDate: date,
      });
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      intent.current = null;
      setRuns((current) => [
        latestRun(
          current.find((run) => run.id === result.run.id),
          result.run,
        ),
        ...current.filter((run) => run.id !== result.run.id),
      ]);
      setSelectedId(result.run.id);
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function cancel(run: AgentRun) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await post<{ run: AgentRun }>(
        `/api/agent/runs/${encodeURIComponent(run.id)}/cancel`,
        {},
      );
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      setRuns((current) =>
        current.map((item) => (item.id === run.id ? latestRun(item, result.run) : item)),
      );
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function apply(run: AgentRun) {
    if (
      operation.current ||
      run.status !== 'completed' ||
      run.result?.status !== 'proposal' ||
      run.baseRevision !== revision
    )
      return;
    operation.current = true;
    setBusy(true);
    setError('');
    if (!appliedIntent.current.has(run.id)) appliedIntent.current.set(run.id, crypto.randomUUID());
    try {
      const result = await post<StateResponse & { run: AgentRun }>(
        `/api/agent/runs/${encodeURIComponent(run.id)}/apply`,
        { requestId: appliedIntent.current.get(run.id) },
      );
      if (!active.current) return;
      refreshSequence.current += 1;
      setLoading(false);
      onApplied(result);
      setRuns((current) =>
        current.map((item) => (item.id === run.id ? latestRun(item, result.run) : item)),
      );
    } catch (failure) {
      if (active.current) setError(errorMessage(failure));
    } finally {
      operation.current = false;
      if (active.current) setBusy(false);
    }
  }
  const proposedRecipes =
    selected?.result?.changes
      .filter((change) => change.type === 'recipe')
      .map((change) => change.data) ?? [];
  const recipes = new Map(
    [...state.recipes, ...proposedRecipes].map((recipe) => [recipe.id, recipe]),
  );
  const stale = Boolean(
    selected?.status === 'completed' &&
    selected.result?.status === 'proposal' &&
    selected.baseRevision !== revision,
  );
  return (
    <div className="agent-workspace corner-ui">
      <div className="agent-compose-layout">
        <form className="agent-compose" onSubmit={start}>
          <div className="eyebrow">YOUR PLANS, WITH ROOM TO ADAPT</div>
          <h2>What would help today?</h2>
          <p>
            Create a meal plan, build a routine, or work around a change of plans. The agent uses
            your profile and saved records.
          </p>
          <Field className="field">
            <FieldLabel htmlFor={promptId}>Your request</FieldLabel>
            <Textarea
              id={promptId}
              name="prompt"
              ref={textarea}
              rows={5}
              maxLength={6000}
              required
              minLength={3}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                intent.current = null;
              }}
              placeholder="I have 30 minutes to train today. Adapt my planned workout to fit."
            />
          </Field>
          <div className="agent-suggestions">
            {[
              'Build a training week around my goals.',
              'Plan varied meals for next week.',
              'Review my recent progress.',
            ].map((value) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                key={value}
                className="agent-suggestion-btn"
                onClick={() => {
                  setPrompt(value);
                  intent.current = null;
                  textarea.current?.focus();
                }}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="agent-submit-row">
            <Field className="field">
              <FieldLabel htmlFor={dateId}>Reference date</FieldLabel>
              <Input
                id={dateId}
                name="referenceDate"
                type="date"
                required
                value={date}
                onChange={(event) => {
                  setDate(event.target.value);
                  intent.current = null;
                }}
              />
            </Field>
            <Button
              variant="default"
              type="submit"
              disabled={busy || !ready || prompt.trim().length < 3 || runs.some(isActive)}
            >
              {busy ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
              {busy ? 'Please wait…' : 'Ask my agent'}
            </Button>
          </div>
          <p className="agent-review-note">
            You’ll review the details before any proposal changes your plans.
          </p>
        </form>
        <AgentConnection
          onChanged={() => {
            void refresh();
            onRefresh();
          }}
        />
      </div>
      {error && (
        <Alert variant="destructive" className="form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <section className="agent-history" aria-label="Agent requests">
        <div className="section-heading">
          <h2>Your requests</h2>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={loading || busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            Refresh
          </Button>
        </div>
        {runs.length > 0 && (
          <ToggleGroup
            className="agent-run-picker"
            aria-label="Choose an agent request"
            value={selected ? [selected.id] : []}
            onValueChange={(values) => {
              if (values[0]) setSelectedId(String(values[0]));
            }}
          >
            {runs.slice(0, 20).map((run) => (
              <ToggleGroupItem value={run.id} key={run.id}>
                <span>{run.result?.title || run.prompt}</span>
                <small>
                  {when(run.createdAt)} · {run.status}
                </small>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {!loading && !runs.length && (
          <Empty className="agent-empty">
            <EmptyMedia variant="icon">
              <Sparkles size={20} />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>A useful next step starts here.</EmptyTitle>
              <EmptyDescription>
                Ask a question or describe what you want to change. Your requests and reviewed
                proposals stay in this account.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
      {selected && (
        <section
          className="agent-result"
          aria-live={isActive(selected) ? 'polite' : 'off'}
          aria-busy={isActive(selected)}
        >
          <div className="agent-result-top">
            <Badge
              variant={
                selected.status === 'applied'
                  ? 'default'
                  : isActive(selected)
                    ? 'secondary'
                    : selected.result?.status === 'proposal'
                      ? 'outline'
                      : 'secondary'
              }
              className="eyebrow"
            >
              {selected.status === 'applied'
                ? 'APPLIED TO YOUR WORKSPACE'
                : isActive(selected)
                  ? 'WORKING ON YOUR REQUEST'
                  : selected.result?.status === 'proposal'
                    ? 'PROPOSAL · REVIEW BEFORE APPLYING'
                    : 'YOUR REQUEST'}
            </Badge>
            <p>{selected.prompt}</p>
          </div>
          {isActive(selected) && (
            <div className="agent-running">
              <Loader2 size={22} className="spin" />
              <div>
                <h3>Your agent is working.</h3>
                <p>
                  This may take a little while. You can leave this page and return to the saved
                  request.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void cancel(selected)}
              >
                <Square size={14} />
                Cancel request
              </Button>
            </div>
          )}
          {selected.status === 'failed' && (
            <Alert variant="destructive" className="form-error">
              <AlertDescription>
                {selected.error ||
                  'The agent could not complete this request. Review your connection and try again.'}
              </AlertDescription>
            </Alert>
          )}
          {selected.status === 'cancelled' && (
            <Alert variant="default" className="agent-cancelled">
              <AlertDescription>Request cancelled. No proposal was applied.</AlertDescription>
            </Alert>
          )}
          {selected.result && (
            <>
              <div className="agent-answer">
                <h2>{selected.result.title}</h2>
                <p>{selected.result.message}</p>
                {selected.result.questions.length > 0 && (
                  <div className="agent-questions">
                    <h3>A little more detail</h3>
                    <ul>
                      {selected.result.questions.map((question, index) => (
                        <li key={index}>{question}</li>
                      ))}
                    </ul>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setPrompt(
                          `${selected.prompt}\n\n${selected.result!.questions.map((question) => `${question}\n`).join('\n')}`,
                        );
                        intent.current = null;
                        textarea.current?.focus();
                        textarea.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      }}
                    >
                      Add details <ArrowRight size={15} />
                    </Button>
                  </div>
                )}
              </div>
              {selected.result.changes.length > 0 && (
                <div className="agent-changes">
                  {selected.result.changes.map((change, index) => (
                    <ChangePreview
                      key={`${change.type}-${index}`}
                      change={change}
                      state={state}
                      recipes={recipes}
                    />
                  ))}
                </div>
              )}
              {selected.status === 'completed' && selected.result.status === 'proposal' && (
                <div className="agent-apply">
                  <div>
                    <h3>
                      {selected.result.changes.length} proposed{' '}
                      {selected.result.changes.length === 1 ? 'change' : 'changes'}
                    </h3>
                    <p>
                      {stale
                        ? 'Your workspace changed after this proposal. Ask for an updated version before applying it.'
                        : 'Review every change above. Apply updates the plan; it does not log food or completed workouts.'}
                    </p>
                  </div>
                  {stale ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setPrompt(selected.prompt);
                        intent.current = null;
                        textarea.current?.focus();
                        textarea.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                      }}
                    >
                      Update this request <ArrowRight size={16} />
                    </Button>
                  ) : (
                    <Button
                      variant="default"
                      disabled={busy || loading}
                      onClick={() => void apply(selected)}
                    >
                      {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}Apply{' '}
                      {selected.result.changes.length === 1
                        ? 'change'
                        : `${selected.result.changes.length} changes`}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {selected.status === 'applied' && (
            <Alert variant="success" className="agent-applied">
              <Check size={18} />
              <AlertDescription>
                Applied. Your plans are ready to review in the workspace.
              </AlertDescription>
            </Alert>
          )}
        </section>
      )}
    </div>
  );
}
