"use client";

import { useMemo, useState } from 'react';
import { getMealPlanSummary } from '@corner/shared/meal-plan-summary';
import type { AppState, Macros } from '@corner/shared/types';
import './meal-planner-summary.css';

const metrics = [
  { key: 'calories', label: 'Calories', unit: 'kcal', digits: 0 },
  { key: 'protein', label: 'Protein', unit: 'g', digits: 1 },
  { key: 'carbs', label: 'Carbs', unit: 'g', digits: 1 },
  { key: 'fat', label: 'Fat', unit: 'g', digits: 1 },
] as const;
const number = (value: number, digits = 0) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
function difference(planned: number, target: number, unit: string, digits: number): string {
  const scale = 10 ** digits;
  const delta = Math.round((planned - target) * scale) / scale;
  return delta === 0 ? 'On target' : `${number(Math.abs(delta), digits)} ${unit} ${delta > 0 ? 'above' : 'below'} target`;
}

export default function MealPlannerSummary({ state, weekStart }: { state: AppState; weekStart: string }) {
  const [mode, setMode] = useState<'weekly' | 'daily'>('weekly');
  const summary = useMemo(() => getMealPlanSummary(state, weekStart), [state, weekStart]);
  const planned = mode === 'weekly' ? summary.planned : summary.averagePlanned;
  const target = mode === 'weekly' ? summary.target : summary.averageTarget;
  const targetsSet = state.settings.setup?.nutritionTargetsSet ?? (state.settings.training.calories > 0 && state.settings.rest.calories > 0);
  return <section className="panel meal-plan-summary" aria-label="Planned nutrition and targets">
    <div className="meal-plan-summary-heading">
      <div><h2>Plan & targets</h2><p>Your planned meals, alongside your nutrition goals.</p></div>
      <div className="meal-plan-summary-mode" role="group" aria-label="Nutrition summary period">
        <button type="button" aria-pressed={mode === 'weekly'} onClick={() => setMode('weekly')}>Weekly total</button>
        <button type="button" aria-pressed={mode === 'daily'} onClick={() => setMode('daily')}>Daily average</button>
      </div>
    </div>
    <div className="meal-plan-summary-metrics" aria-live="polite" aria-atomic="true">
      {metrics.map(metric => <div className="meal-plan-summary-metric" key={metric.key}>
        <h3>{metric.label}</h3>
        <div className="meal-plan-summary-value"><strong>{number(planned[metric.key], metric.digits)}</strong><span>{metric.unit} planned{mode === 'daily' ? ' / day' : ''}</span></div>
        {targetsSet ? <><p className="meal-plan-summary-target">Target <b>{number(target[metric.key], metric.digits)} {metric.unit}</b>{mode === 'daily' && <span> / day</span>}</p><p className="meal-plan-summary-difference">{difference(planned[metric.key], target[metric.key], metric.unit, metric.digits)}</p></> : <p className="meal-plan-summary-target">Set targets in your profile when you’re ready.</p>}
      </div>)}
    </div>
    <div className="meal-plan-summary-note">
      <span><b>{summary.plannedMealCount}</b> planned {summary.plannedMealCount === 1 ? 'meal' : 'meals'} · <b>{summary.plannedDayCount} of 7</b> days have meals</span>
      <span>{mode === 'daily' ? 'Averages use all 7 days, including empty days.' : targetsSet ? 'Targets add up all 7 days of your training schedule.' : 'Weekly totals include all planned meals.'} Nutrition is estimated.</span>
    </div>
  </section>;
}

export function PlannerDayMacros({ planned, target, targetsSet = true }: { planned: Macros; target: Macros; targetsSet?: boolean }) {
  return <div className="planner-day-total planner-day-macros" role="group" aria-label="Planned nutrition and daily targets">
    <span className="planner-day-macros-label">{targetsSet ? 'Planned / target' : 'Planned nutrition'}</span>
    <strong>{number(planned.calories)} <span>kcal planned</span></strong>
    <small>{targetsSet ? `Target ${number(target.calories)} kcal` : 'Targets not set'}</small>
    <dl className="planner-day-macro-values">{metrics.slice(1).map(metric => <div key={metric.key}>
      <dt>{metric.label}</dt>
      <dd><b>{number(planned[metric.key], 1)}</b><span>{targetsSet ? ` / ${number(target[metric.key], 1)} g` : ' g'}</span></dd>
    </div>)}</dl>
  </div>;
}
