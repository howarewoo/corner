import { useEffect, useState } from 'react';
import { Button } from '@packages/ui';
import type {
  WorkoutExercise,
  WorkoutSession,
  WorkoutSet,
  WorkoutTiming,
} from '@packages/training/types';

export const runningRest = (timing?: WorkoutTiming) =>
  timing?.rests.find((rest) => !rest.endedAt && !rest.interrupted);
export function clock(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(value % 60).padStart(2, '0')}`;
}
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const update = () => setNow(Date.now());
    const interval = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return now;
}
export function WorkoutClock({ timing }: { timing?: WorkoutTiming }) {
  const now = useNow();
  const rest = runningRest(timing);
  const elapsed = timing
    ? ((timing.endedAt ? Date.parse(timing.endedAt) : now) - Date.parse(timing.startedAt)) / 1000
    : null;
  const remaining = rest
    ? Math.ceil(rest.targetSeconds - Math.max(0, (now - Date.parse(rest.startedAt)) / 1000))
    : null;
  return (
    <span className="workout-clock" role="timer" aria-live="off" aria-label="Workout timing">
      {elapsed === null ? 'Start time unknown' : `${clock(elapsed)} elapsed`}
      {remaining !== null &&
        ` · ${remaining > 0 ? `Rest ${clock(remaining)}` : 'Ready for next set'}`}
    </span>
  );
}
export function recordSetRest(
  timing: WorkoutTiming,
  exercise: WorkoutExercise,
  set: WorkoutSet,
  completed: boolean,
  now = new Date().toISOString(),
): WorkoutTiming {
  const rests = timing.rests.filter(
    (rest) => rest.exerciseId !== exercise.id || rest.setId !== set.id,
  );
  if (!completed || set.completed)
    return { ...timing, rests: set.completed === completed ? timing.rests : rests };
  return {
    ...timing,
    rests: [
      ...rests.map((rest) =>
        !rest.endedAt && !rest.interrupted ? { ...rest, interrupted: true as const } : rest,
      ),
      {
        exerciseId: exercise.id,
        setId: set.id,
        startedAt: now,
        targetSeconds: exercise.restSeconds ?? 0,
      },
    ],
  };
}
export function finishTimedWorkout(
  session: WorkoutSession,
  now = new Date().toISOString(),
): WorkoutSession {
  return {
    ...session,
    status: 'completed',
    updatedAt: now,
    ...(session.timing
      ? {
          durationMinutes: Math.max(
            0,
            (Date.parse(now) - Date.parse(session.timing.startedAt)) / 60000,
          ),
          timing: {
            ...session.timing,
            endedAt: now,
            rests: session.timing.rests.map((rest) =>
              !rest.endedAt && !rest.interrupted ? { ...rest, interrupted: true as const } : rest,
            ),
          },
        }
      : {}),
  };
}
export function RestControls({
  timing,
  onChange,
}: {
  timing: WorkoutTiming;
  onChange: (timing: WorkoutTiming) => void;
}) {
  const now = useNow();
  const rest = runningRest(timing);
  if (!rest) return null;
  const remaining = Math.ceil(
    rest.targetSeconds - Math.max(0, (now - Date.parse(rest.startedAt)) / 1000),
  );
  const update = (updates: Partial<WorkoutTiming['rests'][number]>) =>
    onChange({
      ...timing,
      rests: timing.rests.map((item) => (item === rest ? { ...item, ...updates } : item)),
    });
  return (
    <div className="workout-rest-controls" aria-label="Rest between sets">
      <span role="timer" aria-live="off">
        {remaining > 0 ? `Rest ${clock(remaining)}` : 'Ready'}
        <small> · {clock((now - Date.parse(rest.startedAt)) / 1000)} resting</small>
      </span>
      <div className="button-row">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Reduce rest target by 15 seconds"
          onClick={() => update({ targetSeconds: Math.max(0, rest.targetSeconds - 15) })}
        >
          −15s
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Extend rest target by 15 seconds"
          onClick={() => update({ targetSeconds: Math.min(86400, rest.targetSeconds + 15) })}
        >
          +15s
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => update({ endedAt: new Date().toISOString() })}
        >
          Start next set
        </Button>
      </div>
    </div>
  );
}
