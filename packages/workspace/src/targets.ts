import { DateSchema } from '@packages/nutrition/schemas';
import type { Macros } from '@packages/nutrition/types';
import type { AppState, Settings } from './types.js';

export type ActivityContext = {
  settings: Settings;
  training: Pick<AppState['training'], 'sessions' | 'scheduledDates'>;
};

export function activityForDate(settings: Settings, date: string): string {
  DateSchema.parse(date);
  return settings.schedule[String(new Date(`${date}T12:00:00Z`).getUTCDay())] || 'Recovery';
}

export function targetForDate(settings: Settings, date: string): Macros {
  return /\b(rest|recovery|off)\b/i.test(activityForDate(settings, date))
    ? settings.rest
    : settings.training;
}

/** Explicit workout dates take precedence over the recurring schedule. */
export function activityForStateDate(state: ActivityContext, date: string): string {
  DateSchema.parse(date);
  const sessions = state.training?.sessions.filter((session) => session.date === date) ?? [];
  if (!sessions.length && !state.training?.scheduledDates.includes(date))
    return activityForDate(state.settings, date);
  const kinds = new Set(
    sessions.filter((session) => session.status !== 'skipped').map((session) => session.kind),
  );
  const activities = [
    kinds.has('boxing') ? 'Boxing' : '',
    kinds.has('strength') ? 'Strength' : '',
    kinds.has('conditioning') ? 'Conditioning' : '',
  ].filter(Boolean);
  return activities.join(' + ') || 'Recovery';
}

export function targetForStateDate(state: ActivityContext, date: string): Macros {
  const explicit =
    state.training?.scheduledDates.includes(date) ||
    state.training?.sessions.some((session) => session.date === date);
  if (!explicit) return targetForDate(state.settings, date);
  const hasTraining = state.training.sessions.some(
    (session) =>
      session.date === date && session.status !== 'skipped' && session.kind !== 'recovery',
  );
  return hasTraining ? state.settings.training : state.settings.rest;
}
