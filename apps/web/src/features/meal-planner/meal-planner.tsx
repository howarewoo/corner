import type { AppState } from '@packages/workspace/types';
import type { Recipe } from '@packages/nutrition/types';
import { SLOTS } from '@packages/nutrition/types';
import { activityForStateDate, targetForStateDate } from '@packages/workspace/targets';
import { dateKey, mondayOf, shiftDate, weekDates } from '@packages/nutrition/dates';
import { macroTotal } from '@packages/nutrition/calculations';
import { Sparkles, Copy, Plus, X, ShoppingBasket, ArrowRight } from 'lucide-react';
import {
  Button,
  Badge,
  Label,
  NativeSelect,
  NativeSelectOption,
  WorkspaceHeader,
} from '@packages/ui';
import MealPlannerSummary, { PlannerDayMacros } from '../../components/meal-planner-summary';
import type { Mutate, Notify, Confirmation, Overlay, View } from '../workspace/types';
import { activityIcon, activityLabel, cap, formatDate, newId, num } from '../workspace/utils';
import { DateControls, ResourceStatus } from '../workspace/workspace-ui';
import { nutritionWindow } from '../workspace/resources';
import { readResource, useResource, sessionLifetime } from '../../rpc';

export default function MealPlanner({
  state: previewState,
  selectedDate,
  setSelectedDate,
  disabled,
  navigate,
  mutate,
  notify,
  setOverlay,
  setConfirmation,
  openRecipe,
  openAgent,
}: {
  state?: AppState;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  disabled: boolean;
  navigate: (view: View) => void;
  mutate: Mutate;
  notify: Notify;
  setOverlay: (overlay: Overlay) => void;
  setConfirmation: (confirmation: Confirmation | null) => void;
  openRecipe: (recipe: Recipe) => void;
  openAgent: (prompt?: string) => void;
}) {
  const dates = weekDates(mondayOf(selectedDate));
  const query = useResource(
    'nutrition',
    { from: dates[0], through: dates[6] },
    (signal) => nutritionWindow(dates[0]!, dates[6]!, signal),
    !previewState,
  );
  const state = previewState ?? query.data;
  if (!state || (!previewState && query.isError))
    return (
      <ResourceStatus
        error={query.error}
        loading={query.isPending}
        retry={() => void query.refetch()}
      />
    );
  const targetsSet =
    state.settings.setup?.nutritionTargetsSet ??
    (state.settings.training.calories > 0 && state.settings.rest.calories > 0);
  const currentDate = dateKey(new Date(), state.settings.timezone);
  const weekStart = mondayOf(selectedDate);
  const days = weekDates(weekStart);
  const weekPlan = state.plan.filter((entry) => days.includes(entry.date));
  const copyWeek = async () => {
    try {
      const previousDays = weekDates(shiftDate(weekStart, -7));
      const source =
        previewState ??
        (await readResource(
          'nutrition',
          () => nutritionWindow(previousDays[0]!, days[6]!, new AbortController().signal),
          sessionLifetime(),
        ));
      const previous = source.plan.filter((entry) => previousDays.includes(entry.date));
      if (!previous.length) {
        notify('There are no meals in the previous week to copy.');
        return;
      }
      const mutation: Parameters<Mutate>[0] = {
        type: 'plan.week',
        data: {
          weekStart,
          entries: previous.map((entry) => ({
            ...entry,
            id: newId(),
            date: shiftDate(entry.date, 7),
          })),
          replace: true,
        },
      };
      if (source.plan.some((entry) => days.includes(entry.date))) {
        setConfirmation({
          title: 'Replace this week’s plan?',
          description:
            'Replace this week’s plan with the previous week? Your food log will stay as it is.',
          confirm: () => mutate(mutation, 'Previous week copied'),
        });
        return;
      }
      await mutate(mutation, 'Previous week copied');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load the previous week.', true);
    }
  };
  return (
    <>
      <WorkspaceHeader
        title="Your meal plan."
        eyebrow="A WEEK WITH INTENTION"
        description="Build in variety. Leave a little room for life."
        actions={
          <>
            <DateControls date={selectedDate} setDate={setSelectedDate} week />
            <Button
              variant="default"
              size="default"
              disabled={disabled}
              onClick={() =>
                openAgent(
                  'Help me build a meal plan using my saved preferences. Ask for any details you need.',
                )
              }
            >
              <Sparkles size={16} />
              Plan with my agent
            </Button>
          </>
        }
      />
      <div className="planner-toolbar">
        <div className="toolbar-description">
          <span className="status-dot" />
          <b>{weekPlan.length} planned meals</b>
          <span>·</span>
          <span>Portions update your grocery list automatically</span>
        </div>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void copyWeek()}>
          <Copy size={15} />
          Copy previous week
        </Button>
      </div>
      {previewState && !previewState.recipes.length && (
        <div className="onboarding-nudge">
          <div>
            <h3>Your first recipe starts the plan.</h3>
            <p>Add a favorite to your collection, then choose it for a meal.</p>
          </div>
          <Button
            variant="outline"
            size="default"
            onClick={() => setOverlay({ kind: 'recipeForm' })}
          >
            <Plus size={16} />
            Add recipe
          </Button>
        </div>
      )}
      <MealPlannerSummary state={state} weekStart={weekStart} />
      <div className="planner-scroll">
        <div className="planner-grid">
          {days.map((day) => {
            const a = activityForStateDate(state, day),
              Icon = activityIcon(a);
            const entries = state.plan.filter((entry) => entry.date === day);
            const totals = macroTotal(
              entries.flatMap((entry) => {
                const r = state.recipes.find((r) => r.id === entry.recipeId);
                return r ? [{ nutrition: r.nutrition, servings: entry.servings }] : [];
              }),
            );
            return (
              <section className={`planner-day ${day === currentDate ? 'is-today' : ''}`} key={day}>
                <div className="planner-day-heading">
                  <div>
                    <span>{formatDate(day, { weekday: 'short' })}</span>
                    <strong>{formatDate(day, { day: 'numeric' })}</strong>
                  </div>
                  <Badge variant="secondary" className="planner-activity" title={activityLabel(a)}>
                    <Icon size={15} />
                    {activityLabel(a).replace(' day', '')}
                  </Badge>
                </div>
                <div className="planner-slots">
                  {SLOTS.map((slot) => (
                    <div className="planner-slot" key={slot}>
                      <div className="slot-label">
                        <span>{cap(slot)}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Add ${slot} on ${formatDate(day, { weekday: 'long' })}`}
                          disabled={disabled}
                          onClick={() => setOverlay({ kind: 'pick', date: day, slot })}
                        >
                          <Plus size={13} />
                        </Button>
                      </div>
                      {entries
                        .filter((entry) => entry.slot === slot)
                        .map((entry) => {
                          const recipe = state.recipes.find((r) => r.id === entry.recipeId);
                          if (!recipe) return null;
                          return (
                            <div className={`plan-tile ${recipe.category}`} key={entry.id}>
                              <Button
                                variant="ghost"
                                size="default"
                                onClick={() => openRecipe(recipe)}
                                className="plan-tile-name"
                              >
                                {recipe.name}
                              </Button>
                              <div className="plan-tile-macros">
                                {num(recipe.nutrition.calories * entry.servings)} kcal{' '}
                                <span>· {num(recipe.nutrition.protein * entry.servings)}g P</span>
                              </div>
                              <div className="plan-tile-bottom">
                                <Label>
                                  <span className="sr-only">
                                    Servings for {recipe.name} on {day}
                                  </span>
                                  <NativeSelect
                                    value={entry.servings}
                                    disabled={disabled}
                                    onChange={(e) =>
                                      void mutate({
                                        type: 'plan.save',
                                        data: {
                                          ...entry,
                                          servings: Number(e.target.value),
                                        },
                                      })
                                    }
                                  >
                                    {Array.from(
                                      new Set([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, entry.servings]),
                                    )
                                      .sort((a, b) => a - b)
                                      .map((n) => (
                                        <NativeSelectOption value={n} key={n}>
                                          {n} serving{n === 1 ? '' : 's'}
                                        </NativeSelectOption>
                                      ))}
                                  </NativeSelect>
                                </Label>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Remove ${recipe.name} from ${day}`}
                                  disabled={disabled}
                                  onClick={() =>
                                    void mutate({
                                      type: 'plan.delete',
                                      data: { id: entry.id },
                                    })
                                  }
                                  className="tile-remove"
                                >
                                  <X size={13} />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      {!entries.some((entry) => entry.slot === slot) && (
                        <Button
                          variant="ghost"
                          size="default"
                          disabled={disabled}
                          onClick={() => setOverlay({ kind: 'pick', date: day, slot })}
                          className="slot-empty"
                        >
                          <Plus size={12} />
                          <span>Add meal</span>
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
                <PlannerDayMacros
                  planned={totals}
                  target={targetForStateDate(state, day)}
                  targetsSet={targetsSet}
                />
              </section>
            );
          })}
        </div>
      </div>
      <div className="planner-bottom-note">
        <span>
          <ShoppingBasket size={17} />
          Your shopping list follows the plan, serving for serving.
        </span>
        <Button variant="link" size="default" onClick={() => navigate('groceries')}>
          View grocery list <ArrowRight size={15} />
        </Button>
      </div>
    </>
  );
}
