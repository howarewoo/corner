import type { AppState, Recipe, PlanEntry } from '@packages/shared/types';
import { SLOTS } from '@packages/shared/types';
import {
  activityForStateDate,
  dateKey,
  mondayOf,
  weekDates,
  macroTotal,
  targetForStateDate,
} from '@packages/shared/domain';
import {
  Activity,
  Dumbbell,
  Leaf,
  ArrowRight,
  ArrowUpRight,
  UtensilsCrossed,
  Check,
  Plus,
  ClipboardList,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  Button,
  Badge,
  Card,
  Label,
  NativeSelect,
  NativeSelectOption,
  ToggleGroup,
  ToggleGroupItem,
  WorkspaceHeader,
} from '@packages/ui';
import type { Mutate, Notify, Overlay, View } from '../workspace/types';
import { activityIcon, activityLabel, cap, formatDate, newId, num } from '../workspace/utils';
import { DateControls, Empty, IconButton, MacroLine, Progress } from '../workspace/workspace-ui';

export default function Today({
  state,
  selectedDate,
  setSelectedDate,
  displayName,
  disabled,
  navigate,
  mutate,
  notify,
  setOverlay,
  openRecipe,
}: {
  state: AppState;
  selectedDate: string;
  setSelectedDate: (date: string) => void;
  displayName: string;
  disabled: boolean;
  navigate: (view: View) => void;
  mutate: Mutate;
  notify: Notify;
  setOverlay: (overlay: Overlay) => void;
  openRecipe: (recipe: Recipe) => void;
}) {
  const targetsSet =
    state.settings.setup?.nutritionTargetsSet ??
    (state.settings.training.calories > 0 && state.settings.rest.calories > 0);
  const currentDate = dateKey(new Date(), state.settings.timezone);
  const selectedActivity = activityForStateDate(state, selectedDate);
  const ActivityIcon = activityIcon(selectedActivity);
  const weekStart = mondayOf(selectedDate);
  const days = weekDates(weekStart);
  const dayPlan = state.plan
    .filter((entry) => entry.date === selectedDate)
    .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  const dayLogs = state.logs
    .filter((entry) => entry.date === selectedDate)
    .sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  const actual = macroTotal(dayLogs);
  const planned = macroTotal(
    dayPlan.flatMap((entry) => {
      const recipe = state.recipes.find((r) => r.id === entry.recipeId);
      return recipe ? [{ nutrition: recipe.nutrition, servings: entry.servings }] : [];
    }),
  );
  const target = targetForStateDate(state, selectedDate);
  const firstName = (state.settings.name || displayName || 'you').split(' ')[0];
  const logMeal = async (entry: PlanEntry) => {
    const recipe = state.recipes.find((r) => r.id === entry.recipeId);
    if (!recipe) return;
    const alreadyLogged = state.logs.some((log) => log.planEntryId === entry.id);
    if (alreadyLogged) {
      notify('This planned meal is already in your food log. Edit its portion in the log.');
      return;
    }
    await mutate(
      {
        type: 'log.save',
        data: {
          id: newId(),
          date: entry.date,
          slot: entry.slot,
          name: recipe.name,
          nutrition: recipe.nutrition,
          servings: entry.servings,
          recipeId: recipe.id,
          planEntryId: entry.id,
          createdAt: new Date().toISOString(),
        },
      },
      'Meal added to your food log',
    );
  };
  return (
    <>
      <WorkspaceHeader
        title={
          selectedDate === currentDate
            ? `In your corner, ${firstName}.`
            : formatDate(selectedDate, { month: 'long', day: 'numeric' })
        }
        actions={
          <>
            <DateControls date={selectedDate} setDate={setSelectedDate} />
            {selectedDate !== currentDate && (
              <Button variant="ghost" size="default" onClick={() => setSelectedDate(currentDate)}>
                Today
              </Button>
            )}
          </>
        }
      />
      <div className="today-grid">
        <section className="rhythm-panel" aria-labelledby="training-week-title">
          <div className="rhythm-heading">
            <h2 id="training-week-title">Your training week</h2>
            <p className="rhythm-current">{activityLabel(selectedActivity)}</p>
            <p>
              {formatDate(selectedDate, {
                weekday: 'long',
                month: 'short',
                day: 'numeric',
              })}{' '}
              · {selectedActivity}
            </p>
          </div>
          <ToggleGroup
            className="rhythm-days"
            aria-label="Training week day"
            value={[selectedDate]}
            onValueChange={(values) => {
              if (values[0]) setSelectedDate(String(values[0]));
            }}
          >
            {days.map((day) => {
              const a = activityForStateDate(state, day),
                Icon = activityIcon(a);
              return (
                <ToggleGroupItem
                  value={day}
                  key={day}
                  aria-label={`${formatDate(day, { weekday: 'long' })}: ${activityLabel(a)}`}
                  title={`${formatDate(day, { weekday: 'long' })}: ${activityLabel(a)}`}
                >
                  <span>{formatDate(day, { weekday: 'short' })}</span>
                  <i>
                    <Icon size={16} />
                  </i>
                </ToggleGroupItem>
              );
            })}
          </ToggleGroup>
          <div className="rhythm-footer">
            <div className="rhythm-legend">
              <span>
                <Activity size={13} />
                Conditioning
              </span>
              <span>
                <Dumbbell size={13} />
                Strength
              </span>
              <span>
                <Leaf size={13} />
                Recovery
              </span>
            </div>
            <Button
              variant="ghost"
              size="default"
              onClick={() => navigate('workouts')}
              className="rhythm-link"
            >
              Open your workouts <ArrowRight size={16} />
            </Button>
          </div>
        </section>
        <Card className="panel nutrition-panel">
          <div className="panel-heading">
            <div>
              <h2>Today’s nutrition</h2>
              <p>What you’ve logged, against your daily targets.</p>
            </div>
            <Badge variant="secondary" className="activity-badge">
              <ActivityIcon size={14} />
              {activityLabel(selectedActivity)}
            </Badge>
          </div>
          <div className="nutrition-main">
            <div className="calorie-ring">
              <svg viewBox="0 0 184 184" aria-hidden="true">
                <circle className="ring-track" cx="92" cy="92" r="76" />
                <circle
                  className="ring-fill"
                  cx="92"
                  cy="92"
                  r="76"
                  strokeDasharray={`${(targetsSet ? Math.min(actual.calories / Math.max(target.calories, 1), 1) : 0) * 477.52} 477.52`}
                />
              </svg>
              <div>
                <span className="calorie-label">CALORIES LOGGED</span>
                <strong>{num(actual.calories)}</strong>
                <span>{targetsSet ? `of ${num(target.calories)} kcal` : 'Targets not set'}</span>
              </div>
            </div>
            <div className="macro-progress-list">
              <Progress
                value={actual.protein}
                target={target.protein}
                label="Protein"
                targetsSet={targetsSet}
              />
              <Progress
                value={actual.carbs}
                target={target.carbs}
                label="Carbs"
                targetsSet={targetsSet}
              />
              <Progress
                value={actual.fat}
                target={target.fat}
                label="Fat"
                targetsSet={targetsSet}
              />
            </div>
          </div>
          <div className="nutrition-footer">
            <span>
              <span className="tiny-dot" />
              {!targetsSet
                ? 'Set targets when you’re ready'
                : actual.calories <= target.calories
                  ? `${num(target.calories - actual.calories)} kcal remaining`
                  : `${num(actual.calories - target.calories)} kcal above target`}
            </span>
            <Button variant="ghost" size="default" onClick={() => navigate('settings')}>
              {targetsSet ? 'Adjust targets' : 'Set targets'} <ArrowUpRight size={13} />
            </Button>
          </div>
        </Card>
      </div>
      <div className="today-bottom-grid">
        <Card className="panel meals-panel">
          <div className="panel-heading">
            <div>
              <h2>On the menu</h2>
              <p>
                {dayPlan.length
                  ? `${dayPlan.length} meals · ${num(planned.calories)} kcal planned`
                  : 'A little structure for the day ahead.'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => navigate('planner')}>
              Edit plan <ArrowUpRight size={14} />
            </Button>
          </div>
          {dayPlan.length ? (
            <div className="planned-meals">
              {dayPlan.map((entry) => {
                const recipe = state.recipes.find((r) => r.id === entry.recipeId);
                if (!recipe) return null;
                const logged = state.logs.some((log) => log.planEntryId === entry.id);
                return (
                  <div className="planned-meal" key={entry.id}>
                    <span className={`meal-glyph ${recipe.category}`}>
                      <UtensilsCrossed size={18} strokeWidth={1.5} />
                    </span>
                    <div className="planned-meal-info">
                      <span className="mini-label">{cap(entry.slot)}</span>
                      <Button
                        variant="link"
                        size="default"
                        onClick={() => openRecipe(recipe)}
                        className="meal-name"
                      >
                        {recipe.name}
                      </Button>
                      <MacroLine nutrition={recipe.nutrition} servings={entry.servings} />
                    </div>
                    <div className="planned-meal-actions">
                      <Label className="portion-select">
                        <span className="sr-only">Servings for {recipe.name}</span>
                        <NativeSelect
                          aria-label={`Servings for ${recipe.name}`}
                          value={entry.servings}
                          disabled={disabled || logged}
                          onChange={(e) =>
                            void mutate({
                              type: 'plan.save',
                              data: { ...entry, servings: Number(e.target.value) },
                            })
                          }
                        >
                          {[
                            0.5,
                            0.75,
                            1,
                            1.25,
                            1.5,
                            2,
                            2.5,
                            3,
                            ...([0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3].includes(entry.servings)
                              ? []
                              : [entry.servings]),
                          ]
                            .sort((a, b) => a - b)
                            .map((n) => (
                              <NativeSelectOption value={n} key={n}>
                                {n}×
                              </NativeSelectOption>
                            ))}
                        </NativeSelect>
                      </Label>
                      <Button
                        variant={logged ? 'secondary' : 'outline'}
                        size="sm"
                        disabled={disabled || logged}
                        onClick={() => void logMeal(entry)}
                      >
                        {logged ? <Check size={14} /> : <Plus size={14} />}
                        {logged ? 'Logged' : 'Log meal'}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              title="Make room for a good meal"
              action={
                <Button
                  variant="default"
                  size="sm"
                  onClick={() =>
                    setOverlay({ kind: 'pick', date: selectedDate, slot: 'breakfast' })
                  }
                >
                  <Plus size={15} />
                  Plan a meal
                </Button>
              }
            >
              Choose from your recipes and build a day that works for you.
            </Empty>
          )}
          <div className="panel-footnote">
            Planned meals count toward your nutrition only when you log them.
          </div>
        </Card>
        <Card className="panel food-log-panel">
          <div className="panel-heading">
            <div>
              <h2>Food log</h2>
              <p>
                {dayLogs.length
                  ? `${dayLogs.length} ${dayLogs.length === 1 ? 'entry' : 'entries'} for this day`
                  : 'A record of what you actually ate.'}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setOverlay({ kind: 'food' })}>
              <Plus size={15} />
              Add food
            </Button>
          </div>
          {dayLogs.length ? (
            <div className="food-log-list">
              {dayLogs.map((log) => (
                <div key={log.id} className="food-log-row">
                  <div>
                    <span className="mini-label">
                      {cap(log.slot)} · {num(log.servings, 2)} serving
                      {log.servings === 1 ? '' : 's'}
                    </span>
                    <h3>{log.name}</h3>
                    <MacroLine nutrition={log.nutrition} servings={log.servings} />
                  </div>
                  <div className="row-actions">
                    <IconButton
                      label={`Edit ${log.name}`}
                      disabled={disabled}
                      onClick={() => setOverlay({ kind: 'food', food: log })}
                    >
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton
                      label={`Delete ${log.name} from log`}
                      disabled={disabled}
                      onClick={() =>
                        void mutate(
                          { type: 'log.delete', data: { id: log.id } },
                          'Food entry removed',
                        )
                      }
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              icon={ClipboardList}
              title="A fresh page"
              action={
                <Button variant="link" size="default" onClick={() => setOverlay({ kind: 'food' })}>
                  Log your first meal <ArrowRight size={14} />
                </Button>
              }
            >
              Nothing logged yet. Add a planned meal or quickly enter something you ate.
            </Empty>
          )}
        </Card>
      </div>
    </>
  );
}
