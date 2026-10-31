// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { WorkoutExercise, WorkoutSession, WorkoutTiming } from '@packages/training/types';
import { WorkoutSessionSchema, WorkoutTimingSchema } from '@packages/training/workouts';
import { finishTimedWorkout, recordSetRest, RestControls, WorkoutClock } from '../workout-timing';

const start = '2026-10-31T10:00:00.000Z';
const timing: WorkoutTiming = { startedAt: start, rests: [] };
const exercise: WorkoutExercise = {
  id: 'squat',
  name: 'Squat',
  loadType: 'total',
  targetSets: 2,
  repMin: 8,
  repMax: 10,
  targetRir: 2,
  restSeconds: 90,
  notes: '',
  sets: [{ id: 'one', weight: 40, reps: 8, rir: 2, completed: false, kind: 'working' }],
};

test('rest starts once, undo removes it, and a later completion leaves unobserved rest unknown', () => {
  const first = recordSetRest(timing, exercise, exercise.sets[0], true, start);
  expect(first.rests).toHaveLength(1);
  expect(
    recordSetRest(first, exercise, { ...exercise.sets[0], completed: true }, true).rests,
  ).toEqual(first.rests);
  expect(
    recordSetRest(first, exercise, { ...exercise.sets[0], completed: true }, false).rests,
  ).toEqual([]);
  const second = recordSetRest(
    first,
    exercise,
    { ...exercise.sets[0], id: 'two' },
    true,
    '2026-10-31T10:02:00.000Z',
  );
  expect(second.rests[0]).toMatchObject({ interrupted: true });
  expect(second.rests[0].endedAt).toBeUndefined();
  expect(WorkoutTimingSchema.safeParse(second).success).toBe(true);
});

test('target expiry remains Ready until an explicit next-set action records measured rest', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const onChange = vi.fn();
  const active = recordSetRest(timing, exercise, exercise.sets[0], true, start);
  const { rerender } = render(<RestControls timing={active} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Extend rest target by 15 seconds' }));
  expect(onChange.mock.lastCall?.[0].rests[0].targetSeconds).toBe(105);
  onChange.mockClear();
  act(() => vi.advanceTimersByTime(110_000));
  expect(screen.getByRole('timer')).toHaveTextContent('Ready');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start next set' }));
  const ended: WorkoutTiming = onChange.mock.lastCall![0];
  expect(ended.rests[0].endedAt).toBe('2026-10-31T10:01:50.000Z');
  rerender(<RestControls timing={ended} onChange={onChange} />);
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
});

test('elapsed time derives from timestamps after suspension and freezes at finish; old sessions stay unknown', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  const { rerender } = render(<WorkoutClock timing={timing} />);
  vi.setSystemTime(new Date('2026-10-31T11:05:12.000Z'));
  act(() => window.dispatchEvent(new Event('focus')));
  expect(screen.getByRole('timer')).toHaveTextContent('1:05:12 elapsed');
  rerender(<WorkoutClock timing={{ ...timing, endedAt: '2026-10-31T10:12:34.000Z' }} />);
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole('timer')).toHaveTextContent('12:34 elapsed');
  rerender(<WorkoutClock />);
  expect(screen.getByRole('timer')).toHaveTextContent('Start time unknown');
});

test('finish preserves measured rests and marks outstanding rest unknown without inventing an end', () => {
  const session: WorkoutSession = {
    id: 'session',
    date: '2026-10-31',
    name: 'Strength',
    kind: 'strength',
    status: 'in_progress',
    unit: 'kg',
    exercises: [exercise],
    plannedMinutes: 45,
    durationMinutes: null,
    rounds: null,
    sessionRpe: null,
    readiness: null,
    notes: '',
    changeReason: '',
    createdAt: start,
    updatedAt: start,
    timing: recordSetRest(timing, exercise, exercise.sets[0], true, start),
  };
  const completed = finishTimedWorkout(session, '2026-10-31T10:15:07.000Z');
  expect(completed.durationMinutes).toBeCloseTo(15 + 7 / 60);
  expect(completed.timing?.rests[0]).toMatchObject({ interrupted: true });
  expect(completed.timing?.rests[0].endedAt).toBeUndefined();
  expect(WorkoutSessionSchema.safeParse(completed).success).toBe(true);
  expect(finishTimedWorkout({ ...session, timing: undefined }).timing).toBeUndefined();
  expect(
    WorkoutTimingSchema.safeParse({ ...timing, endedAt: '2026-10-31T09:59:00.000Z' }).success,
  ).toBe(false);
});
