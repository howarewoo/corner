'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Dumbbell,
  Leaf,
  Loader2,
  Pencil,
  Play,
  Plus,
  SkipForward,
  Sparkles,
  Timer,
  Trash2,
  TrendingUp,
  X,
} from 'lucide-react';
import type { AppState, Settings } from '@packages/workspace/types';
import type { ExerciseChoices, ExerciseHistoryPage } from '@packages/api/workspace-data';
import { rpc, useResource, readResource, sessionLifetime } from '../rpc';
import { calendarPage, requireRevision, useRecordPage, useCursorResource } from '../features/workspace/resources';
import { ResourceStatus, ResourcePaging } from '../features/workspace/workspace-ui';
import type { WorkspaceMutationInput } from '@packages/api/schemas';
import type {
  LoadType,
  TrainingCheckIn,
  TrainingReview,
  WorkoutExercise,
  WorkoutKind,
  WorkoutSession,
  WorkoutSet,
  WorkoutStatus,
  WorkoutTemplate,
} from '@packages/training/types';
import {
  createSessionFromTemplate,
  exerciseHistory,
  trainingStats,
} from '@packages/training/workouts';
import { dateKey, shiftDate, weekDates } from '@packages/nutrition/dates';
import {
  convertTrainingWeight,
  getWorkoutPrefill,
  type WorkoutPrefill,
} from '@packages/training/prefill';
import type { ExerciseCatalogEntry } from '@packages/training/exercise-catalog';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field as UiField,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  WorkspaceHeader,
} from '@packages/ui';
import ExercisePicker, { ExerciseReference } from './exercise-picker';
import './training.css';

type Props = {
  state?: AppState;
  settings: Settings;
  selectedDate: string;
  onDateChange: (date: string) => void;
  mutate: (mutation: WorkspaceMutationInput['mutation'], success?: string) => Promise<boolean>;
  busy: boolean;
  notify: (message: string, error?: boolean) => void;
  onRefresh: () => void;
  onOpenAgent: (prompt?: string) => void;
};
type EditorState = {
  session: WorkoutSession;
  expectedUpdatedAt: string | null;
  template?: WorkoutTemplate;
};
const kindLabels: Record<WorkoutKind, string> = {
  strength: 'Strength',
  boxing: 'Boxing',
  conditioning: 'Conditioning',
  recovery: 'Recovery',
};
const statusLabels: Record<WorkoutStatus, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  completed: 'Completed',
  skipped: 'Skipped',
};
const loadLabels: Record<LoadType, string> = {
  total: 'Total load',
  per_hand: 'Per hand',
  bodyweight: 'Bodyweight + added',
  assistance: 'Assistance',
};
const uid = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `workout-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint32Array(3)), (x) => x.toString(36)).join('')}`;
const todayLabel = (
  value: string,
  options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' },
) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
const n = (value: number, digits = 0) =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits });
const nullableNumber = (value: string) => (value === '' ? null : Number(value));
const blankSet = (): WorkoutSet => ({
  id: uid(),
  weight: null,
  reps: null,
  rir: null,
  completed: false,
  kind: 'working',
});
const blankExercise = (): WorkoutExercise => ({
  id: uid(),
  name: '',
  loadType: 'total',
  targetSets: 2,
  repMin: 8,
  repMax: 12,
  targetRir: null,
  restSeconds: 90,
  notes: '',
  sets: [blankSet(), blankSet()],
});
const doneSets = (session: WorkoutSession) =>
  session.exercises.reduce(
    (sum, exercise) =>
      sum + exercise.sets.filter((set) => set.completed && set.kind === 'working').length,
    0,
  );
const kindIcon = (kind: WorkoutKind) =>
  kind === 'strength' ? Dumbbell : kind === 'recovery' ? Leaf : Activity;

function FormField({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <UiField className={className}>
      <FieldLabel className="field w-full">
        <span>{label}</span>
        {children}
      </FieldLabel>
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </UiField>
  );
}

function IconAction({
  label,
  children,
  className,
  ...props
}: { label: string; children: ReactNode; className?: string } & React.ComponentProps<
  typeof Button
>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      className={className}
      {...props}
    >
      {children}
    </Button>
  );
}

function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Empty className="training-empty">
      <EmptyHeader>
        <EmptyMedia>
          <Dumbbell size={25} strokeWidth={1.6} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

function TrainingDialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="corner-ui training-dialog"
        style={{
          width: `min(${wide ? 880 : 610}px, calc(100vw - 32px))`,
          maxWidth: wide ? 880 : 610,
        }}
        showCloseButton
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function SessionEditor({
  editor,
  history,
  busy,
  onClose,
  onSave,
  onSaveTemplate,
}: {
  editor: EditorState;
  history?: readonly WorkoutSession[];
  busy: boolean;
  onClose: () => void;
  onSave: (session: WorkoutSession, expectedUpdatedAt: string | null) => Promise<boolean>;
  onSaveTemplate: (template: WorkoutTemplate) => Promise<boolean>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<WorkoutSession>(() => structuredClone(editor.session));
  const [error, setError] = useState('');
  const [templateDescription, setTemplateDescription] = useState(
    editor.template?.description ?? '',
  );
  const [restEnd, setRestEnd] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [pickerTarget, setPickerTarget] = useState<string | null>(null);
  const [focusExerciseId, setFocusExerciseId] = useState<string | null>(null);
  const [editedFields, setEditedFields] = useState<Record<string, boolean>>({});
  const [openTargets, setOpenTargets] = useState<Record<string, boolean>>({});
  const templateMode = Boolean(editor.template);
  const prefillContext = {
    id: draft.id, date: draft.date,
    eligible: draft.status === 'planned' || draft.status === 'in_progress',
    exercises: draft.exercises.map((exercise) => ({
      id: exercise.id, name: exercise.name, catalogId: exercise.catalogId, loadType: exercise.loadType,
      needsHistory: exercise.sets.some((set) => set.kind === 'working' && !set.completed),
    })),
  };
  const needsPrefill = !history && !templateMode && prefillContext.eligible && prefillContext.exercises.some((exercise) => exercise.needsHistory);
  const prefill = useResource('prefill', prefillContext,
    (signal) => rpc.workspace.prefill({ session: draft }, { signal }), needsPrefill);
  const prefillHistory = history ?? (prefill.isError ? undefined : prefill.data?.sessions);
  const prefills = useMemo<WorkoutPrefill>(
    () => templateMode || !prefillHistory ? {} : getWorkoutPrefill(draft, prefillHistory),
    [draft, prefillHistory, templateMode],
  );
  const patch = (values: Partial<WorkoutSession>) =>
    setDraft((current) => ({ ...current, ...values }));
  const changeUnit = (unit: 'lb' | 'kg') =>
    setDraft((current) => {
      if (current.unit === unit) return current;
      const factor = unit === 'kg' ? 0.45359237 : 1 / 0.45359237;
      return {
        ...current,
        unit,
        exercises: current.exercises.map((exercise) => ({
          ...exercise,
          sets: exercise.sets.map((set) => ({
            ...set,
            weight: set.weight === null ? null : Number((set.weight * factor).toFixed(3)),
          })),
        })),
      };
    });
  const changeExercise = (id: string, values: Partial<WorkoutExercise>) =>
    setDraft((current) => ({
      ...current,
      exercises: current.exercises.map((exercise) =>
        exercise.id === id ? { ...exercise, ...values } : exercise,
      ),
    }));
  const changeSet = (exerciseId: string, setId: string, values: Partial<WorkoutSet>) =>
    setDraft((current) => ({
      ...current,
      status: values.completed && current.status === 'planned' ? 'in_progress' : current.status,
      exercises: current.exercises.map((exercise) =>
        exercise.id === exerciseId
          ? {
              ...exercise,
              sets: exercise.sets.map((set) => (set.id === setId ? { ...set, ...values } : set)),
            }
          : exercise,
      ),
    }));
  const setValue = (exercise: WorkoutExercise, set: WorkoutSet, field: 'weight' | 'reps' | 'rir') =>
    set[field] ??
    (editedFields[`${exercise.id}:${set.id}:${field}`]
      ? null
      : (prefills[exercise.id]?.[set.id]?.[field] ?? null));
  const editSetValue = (
    exercise: WorkoutExercise,
    set: WorkoutSet,
    field: 'weight' | 'reps' | 'rir',
    value: string,
  ) => {
    setEditedFields((current) => ({ ...current, [`${exercise.id}:${set.id}:${field}`]: true }));
    changeSet(exercise.id, set.id, { [field]: nullableNumber(value) });
  };
  const confirmSet = (exercise: WorkoutExercise, set: WorkoutSet, completed: boolean) =>
    changeSet(
      exercise.id,
      set.id,
      completed
        ? {
            completed,
            weight: setValue(exercise, set, 'weight'),
            reps: setValue(exercise, set, 'reps'),
            rir: setValue(exercise, set, 'rir'),
          }
        : { completed },
    );
  const chooseExercise = (entry?: ExerciseCatalogEntry) => {
    const previous = draft.exercises.find((exercise) => exercise.id === pickerTarget);
    const loadType: LoadType = !entry
      ? 'total'
      : /body\s?weight/i.test(entry.equipment)
        ? 'bodyweight'
        : /dumbbell/i.test(entry.equipment)
          ? 'per_hand'
          : /assisted/i.test(entry.name) && /machine|cable|band|leverage/i.test(entry.equipment)
            ? 'assistance'
            : entry.equipment === 'assisted'
              ? 'bodyweight'
              : 'total';
    const exercise: WorkoutExercise = {
      ...blankExercise(),
      ...(previous
        ? {
            targetSets: previous.targetSets,
            repMin: previous.repMin,
            repMax: previous.repMax,
            targetRir: previous.targetRir,
            restSeconds: previous.restSeconds,
            sets: previous.sets.map((set) => ({ ...blankSet(), kind: set.kind })),
          }
        : {}),
      name: entry ? entry.name.charAt(0).toUpperCase() + entry.name.slice(1) : '',
      catalogId: entry?.id,
      loadType,
    };
    patch({
      exercises: previous
        ? draft.exercises.map((item) => (item.id === previous.id ? exercise : item))
        : [...draft.exercises, exercise],
    });
    setPickerTarget(null);
    setFocusExerciseId(exercise.id);
  };
  useEffect(() => {
    if (!focusExerciseId) return;
    const element = document.getElementById(`workout-exercise-${focusExerciseId}`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFocusExerciseId(null);
  }, [focusExerciseId]);
  useEffect(() => {
    if (restEnd === null) return;
    const update = () => {
      const seconds = Math.max(0, Math.ceil((restEnd - Date.now()) / 1000));
      setRemaining(seconds);
      if (!seconds) setRestEnd(null);
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [restEnd]);
  const moveExercise = (index: number, direction: number) =>
    setDraft((current) => {
      const exercises = [...current.exercises];
      [exercises[index], exercises[index + direction]] = [
        exercises[index + direction],
        exercises[index],
      ];
      return { ...current, exercises };
    });
  const save = async (status?: WorkoutStatus) => {
    setError('');
    if (!formRef.current?.reportValidity()) return;
    const next = { ...draft, status: status ?? draft.status, updatedAt: new Date().toISOString() };
    if (!next.name.trim() || !next.date) {
      setError('Add a workout name and date.');
      return;
    }
    if (
      next.exercises.some((exercise) => !exercise.name.trim() || exercise.repMax < exercise.repMin)
    ) {
      setError(
        'Name each exercise and keep the top rep target at or above the bottom of the range.',
      );
      return;
    }
    if (
      !templateMode &&
      next.exercises.some((exercise) =>
        exercise.sets.some(
          (set) =>
            set.completed &&
            (set.reps === null ||
              set.reps <= 0 ||
              (exercise.loadType !== 'bodyweight' && set.weight === null)),
        ),
      )
    ) {
      setError(
        'For each checked set, enter the reps and load you actually performed. Bodyweight-only sets can leave added load blank.',
      );
      return;
    }
    if (templateMode && next.kind === 'strength' && next.exercises.length === 0) {
      setError('Add at least one exercise to a strength routine.');
      return;
    }
    if (
      !templateMode &&
      next.status === 'completed' &&
      next.kind === 'strength' &&
      doneSets(next) === 0 &&
      !(next.durationMinutes && next.durationMinutes > 0)
    ) {
      setError(
        'Log a completed working set or actual training minutes before completing this workout.',
      );
      return;
    }
    if (
      !templateMode &&
      next.status === 'completed' &&
      ['boxing', 'conditioning'].includes(next.kind) &&
      !(next.durationMinutes && next.durationMinutes > 0)
    ) {
      setError('Enter the minutes you actually trained before completing this session.');
      return;
    }
    if (!templateMode && next.status === 'skipped' && next.changeReason.trim().length < 2) {
      setError('Add a brief plan change or skip reason so the next review has context.');
      return;
    }
    if (
      !templateMode &&
      next.status === 'skipped' &&
      next.exercises.some((exercise) => exercise.sets.some((set) => set.completed))
    ) {
      setError(
        'This session has completed sets. Save it as a partial completed workout, or clear those checks before skipping.',
      );
      return;
    }
    if (templateMode) {
      const template: WorkoutTemplate = {
        ...editor.template!,
        name: next.name,
        kind: next.kind,
        description: templateDescription,
        durationMinutes: next.plannedMinutes,
        exercises: next.exercises.map(({ sets: _sets, ...target }) => target),
        updatedAt: new Date().toISOString(),
      };
      if (await onSaveTemplate(template)) onClose();
    } else if (await onSave(next, editor.expectedUpdatedAt)) onClose();
  };

  return (
    <TrainingDialog
      title={
        templateMode
          ? 'Edit routine'
          : draft.status === 'completed'
            ? 'Workout details'
            : 'Your workout'
      }
      onClose={onClose}
      wide
    >
      {needsPrefill && (!prefill.data || prefill.isError) && <ResourceStatus error={prefill.error} loading={prefill.isPending} retry={() => void prefill.refetch()} />}
      <form
        ref={formRef}
        className="workout-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onInvalidCapture={(event) => {
          const target = event.target as HTMLElement;
          const exerciseEl = target.closest<HTMLElement>('.workout-exercise');
          const exId = exerciseEl?.id.replace('workout-exercise-', '');
          if (exId) {
            setOpenTargets((prev) => ({ ...prev, [exId]: true }));
          }
        }}
      >
        <div className="workout-editor-basics">
          <FormField label="Workout name">
            <Input
              required
              maxLength={160}
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </FormField>
          {!templateMode && (
            <FormField label="Date">
              <Input
                required
                type="date"
                value={draft.date}
                onChange={(event) => patch({ date: event.target.value })}
              />
            </FormField>
          )}
          <FormField label="Session type">
            <NativeSelect
              className="w-full"
              value={draft.kind}
              onChange={(event) => patch({ kind: event.target.value as WorkoutKind })}
            >
              {Object.entries(kindLabels).map(([value, label]) => (
                <NativeSelectOption value={value} key={value}>
                  {label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <FormField label="Planned minutes">
            <Input
              required
              type="number"
              min="0"
              max="600"
              value={draft.plannedMinutes}
              onChange={(event) => patch({ plannedMinutes: Number(event.target.value) })}
            />
          </FormField>
          {!templateMode && (
            <FormField label="Status">
              <NativeSelect
                className="w-full"
                value={draft.status}
                onChange={(event) => patch({ status: event.target.value as WorkoutStatus })}
              >
                {Object.entries(statusLabels).map(([value, label]) => (
                  <NativeSelectOption value={value} key={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          )}
          <FormField label="Load unit" hint="Entered loads convert when you switch units.">
            <NativeSelect
              className="w-full"
              value={draft.unit}
              onChange={(event) => changeUnit(event.target.value as 'lb' | 'kg')}
            >
              <NativeSelectOption value="lb">Pounds (lb)</NativeSelectOption>
              <NativeSelectOption value="kg">Kilograms (kg)</NativeSelectOption>
            </NativeSelect>
          </FormField>
        </div>
        {templateMode ? (
          <FormField label="Routine notes">
            <Textarea
              rows={3}
              maxLength={2000}
              value={templateDescription}
              onChange={(event) => setTemplateDescription(event.target.value)}
            />
          </FormField>
        ) : (
          <p className="workout-convention">
            <Dumbbell size={17} />
            Dumbbell loads are per hand. Record clean reps and your actual reps in reserve.
          </p>
        )}
        <div className="workout-exercises">
          {draft.exercises.map((exercise, index) => (
            <section
              className="workout-exercise"
              key={exercise.id}
              id={`workout-exercise-${exercise.id}`}
              tabIndex={-1}
            >
              <div className="workout-exercise-heading">
                <div>
                  <span className="training-eyebrow">Exercise {index + 1}</span>
                  <h3>{exercise.name || 'New exercise'}</h3>
                  <p>
                    {exercise.targetSets} × {exercise.repMin}–{exercise.repMax} reps ·{' '}
                    {exercise.targetRir === null ? 'RIR not set' : `${exercise.targetRir} RIR`} ·{' '}
                    {loadLabels[exercise.loadType]}
                  </p>
                </div>
                <div className="workout-exercise-actions">
                  <IconAction
                    label={`Move ${exercise.name || 'exercise'} up`}
                    disabled={index === 0}
                    onClick={() => moveExercise(index, -1)}
                  >
                    <ArrowUp size={16} />
                  </IconAction>
                  <IconAction
                    label={`Move ${exercise.name || 'exercise'} down`}
                    disabled={index === draft.exercises.length - 1}
                    onClick={() => moveExercise(index, 1)}
                  >
                    <ArrowDown size={16} />
                  </IconAction>
                  <IconAction
                    label={`Remove ${exercise.name || 'exercise'}`}
                    onClick={() =>
                      patch({
                        exercises: draft.exercises.filter((item) => item.id !== exercise.id),
                      })
                    }
                  >
                    <Trash2 size={17} />
                  </IconAction>
                </div>
              </div>
              <Collapsible
                open={openTargets[exercise.id] ?? (templateMode || !exercise.name)}
                onOpenChange={(isOpen) =>
                  setOpenTargets((prev) => ({ ...prev, [exercise.id]: isOpen }))
                }
                className="workout-target-details"
              >
                <CollapsibleTrigger className="workout-target-summary">
                  <ChevronDown size={15} />
                  {templateMode ? 'Exercise & targets' : 'Edit exercise or targets'}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="workout-target-fields">
                    <FormField
                      label="Exercise name"
                      hint={
                        exercise.catalogId
                          ? 'Use the exercise library to choose a different movement.'
                          : undefined
                      }
                    >
                      <Input
                        required
                        readOnly={Boolean(exercise.catalogId)}
                        maxLength={160}
                        value={exercise.name}
                        onChange={(event) =>
                          changeExercise(exercise.id, {
                            name: event.target.value,
                            targetLoad: undefined,
                          })
                        }
                      />
                    </FormField>
                    <FormField label="How to record load">
                      <NativeSelect
                        className="w-full"
                        value={exercise.loadType}
                        onChange={(event) =>
                          changeExercise(exercise.id, {
                            loadType: event.target.value as LoadType,
                            targetLoad: undefined,
                          })
                        }
                      >
                        {Object.entries(loadLabels).map(([value, label]) => (
                          <NativeSelectOption value={value} key={value}>
                            {label}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </FormField>
                    <FormField label="Target sets">
                      <Input
                        required
                        type="number"
                        min="1"
                        max="20"
                        value={exercise.targetSets}
                        onChange={(event) =>
                          changeExercise(exercise.id, { targetSets: Number(event.target.value) })
                        }
                      />
                    </FormField>
                    <FormField label="Reps from">
                      <Input
                        required
                        type="number"
                        min="1"
                        max="200"
                        value={exercise.repMin}
                        onChange={(event) =>
                          changeExercise(exercise.id, { repMin: Number(event.target.value) })
                        }
                      />
                    </FormField>
                    <FormField label="Reps to">
                      <Input
                        required
                        type="number"
                        min="1"
                        max="200"
                        value={exercise.repMax}
                        onChange={(event) =>
                          changeExercise(exercise.id, { repMax: Number(event.target.value) })
                        }
                      />
                    </FormField>
                    <FormField label="Target RIR">
                      <Input
                        type="number"
                        min="0"
                        max="10"
                        step="0.5"
                        value={exercise.targetRir ?? ''}
                        onChange={(event) =>
                          changeExercise(exercise.id, {
                            targetRir: nullableNumber(event.target.value),
                          })
                        }
                      />
                    </FormField>
                    <FormField
                      label={`Starting load · ${draft.unit}${exercise.loadType === 'per_hand' ? ' / hand' : ''}`}
                      hint="Used when there is no previous logged load. Optional."
                    >
                      <Input
                        type="number"
                        min="0"
                        max="2000"
                        step="any"
                        placeholder="Set once, or enter in your first workout"
                        value={
                          exercise.targetLoad
                            ? convertTrainingWeight(
                                exercise.targetLoad.weight,
                                exercise.targetLoad.unit,
                                draft.unit,
                              )
                            : ''
                        }
                        onChange={(event) =>
                          changeExercise(exercise.id, {
                            targetLoad:
                              event.target.value === ''
                                ? undefined
                                : { weight: Number(event.target.value), unit: draft.unit },
                          })
                        }
                      />
                    </FormField>
                    <FormField label="Rest seconds">
                      <Input
                        required
                        type="number"
                        min="0"
                        max="900"
                        step="1"
                        value={exercise.restSeconds}
                        onChange={(event) =>
                          changeExercise(exercise.id, { restSeconds: Number(event.target.value) })
                        }
                      />
                    </FormField>
                    <FormField label="Exercise notes">
                      <Input
                        maxLength={1200}
                        value={exercise.notes}
                        placeholder="Grip, equipment, or each-side notes"
                        onChange={(event) =>
                          changeExercise(exercise.id, { notes: event.target.value })
                        }
                      />
                    </FormField>
                  </div>
                  <div className="workout-catalog-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={exercise.sets.some(
                        (set) =>
                          set.completed ||
                          set.weight !== null ||
                          set.reps !== null ||
                          set.rir !== null,
                      )}
                      onClick={() => setPickerTarget(exercise.id)}
                    >
                      <Dumbbell size={15} />
                      Choose from exercise library
                    </Button>
                    {exercise.catalogId && (
                      <span className="training-small-note">Linked to exercise database</span>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
              {exercise.catalogId && <ExerciseReference id={exercise.catalogId} />}
              {!templateMode && (
                <>
                  {Object.keys(prefills[exercise.id] ?? {}).length > 0 && (
                    <p className="workout-prefill-note">
                      <Sparkles size={15} />
                      <span>
                        {Object.values(prefills[exercise.id])[0]?.source === 'history'
                          ? `Suggested from ${todayLabel(Object.values(prefills[exercise.id])[0].sourceDate!, { month: 'short', day: 'numeric' })} and your targets.`
                          : 'Prefilled from your plan targets.'}{' '}
                        Review the numbers, then check Done after each set.
                      </span>
                    </p>
                  )}
                  <div className="workout-set-scroll">
                    <Table className="workout-set-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead scope="col">Set</TableHead>
                          <TableHead scope="col">
                            {exercise.loadType === 'per_hand'
                              ? `${draft.unit} / hand`
                              : exercise.loadType === 'assistance'
                                ? `${draft.unit} assist`
                                : exercise.loadType === 'bodyweight'
                                  ? `Added ${draft.unit}`
                                  : draft.unit}
                          </TableHead>
                          <TableHead scope="col">Reps</TableHead>
                          <TableHead scope="col">RIR</TableHead>
                          <TableHead scope="col">Done</TableHead>
                          <TableHead scope="col">
                            <span className="sr-only">Remove</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {exercise.sets.map((set, setIndex) => (
                          <TableRow
                            key={set.id}
                            className={set.completed ? 'workout-set-done' : ''}
                          >
                            <TableCell className="workout-set-type-cell">
                              <span>{setIndex + 1}</span>
                              <NativeSelect
                                size="sm"
                                aria-label={`${exercise.name} set ${setIndex + 1} type`}
                                value={set.kind}
                                onChange={(event) =>
                                  changeSet(exercise.id, set.id, {
                                    kind: event.target.value as 'working' | 'warmup',
                                  })
                                }
                              >
                                <NativeSelectOption value="working">Work</NativeSelectOption>
                                <NativeSelectOption value="warmup">Warm-up</NativeSelectOption>
                              </NativeSelect>
                            </TableCell>
                            <TableCell>
                              <Input
                                aria-label={`${exercise.name} set ${setIndex + 1} weight ${draft.unit}${exercise.loadType === 'per_hand' ? ' per hand' : ''}`}
                                type="number"
                                min="0"
                                max="2000"
                                step="any"
                                placeholder={exercise.loadType === 'bodyweight' ? 'BW' : '—'}
                                data-suggested={
                                  set.weight === null && setValue(exercise, set, 'weight') !== null
                                }
                                value={setValue(exercise, set, 'weight') ?? ''}
                                onChange={(event) =>
                                  editSetValue(exercise, set, 'weight', event.target.value)
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                aria-label={`${exercise.name} set ${setIndex + 1} reps`}
                                type="number"
                                min="0"
                                max="500"
                                step="1"
                                placeholder="—"
                                data-suggested={
                                  set.reps === null && setValue(exercise, set, 'reps') !== null
                                }
                                value={setValue(exercise, set, 'reps') ?? ''}
                                onChange={(event) =>
                                  editSetValue(exercise, set, 'reps', event.target.value)
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Input
                                aria-label={`${exercise.name} set ${setIndex + 1} reps in reserve`}
                                type="number"
                                min="0"
                                max="10"
                                step="0.5"
                                placeholder="—"
                                data-suggested={
                                  set.rir === null && setValue(exercise, set, 'rir') !== null
                                }
                                value={setValue(exercise, set, 'rir') ?? ''}
                                onChange={(event) =>
                                  editSetValue(exercise, set, 'rir', event.target.value)
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Checkbox
                                aria-label={`${exercise.name} set ${setIndex + 1} completed`}
                                checked={set.completed}
                                onCheckedChange={(checked) =>
                                  confirmSet(exercise, set, Boolean(checked))
                                }
                                className="workout-done-checkbox"
                              />
                            </TableCell>
                            <TableCell>
                              <IconAction
                                label={`Remove ${exercise.name} set ${setIndex + 1}`}
                                onClick={() =>
                                  changeExercise(exercise.id, {
                                    sets: exercise.sets.filter((item) => item.id !== set.id),
                                  })
                                }
                              >
                                <X size={16} />
                              </IconAction>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="workout-set-tools">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={exercise.sets.length >= 30}
                      onClick={() =>
                        changeExercise(exercise.id, { sets: [...exercise.sets, blankSet()] })
                      }
                    >
                      <Plus size={15} />
                      Add set
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setRemaining(exercise.restSeconds);
                        setRestEnd(Date.now() + exercise.restSeconds * 1000);
                      }}
                    >
                      <Timer size={15} />
                      Rest {exercise.restSeconds}s
                    </Button>
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
        {pickerTarget ? (
          <ExercisePicker
            key={pickerTarget}
            replacing={pickerTarget !== 'new'}
            onSelect={chooseExercise}
            onCustom={() => chooseExercise()}
            onClose={() => setPickerTarget(null)}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            className="workout-add-exercise"
            onClick={() => setPickerTarget('new')}
            disabled={draft.exercises.length >= 25}
          >
            <Plus size={17} />
            Add exercise
          </Button>
        )}
        {!templateMode && (
          <>
            {draft.exercises.length > 0 && (
              <p className="form-help">
                Only checked working sets count toward training totals. Prefilled values are
                editable suggestions. Warm-up sets stay in your log.
              </p>
            )}
            <section className="workout-session-feedback">
              <h3>How did it go?</h3>
              <div className="workout-feedback-grid">
                <FormField label="Actual minutes">
                  <Input
                    type="number"
                    min="0"
                    max="600"
                    step="0.5"
                    value={draft.durationMinutes ?? ''}
                    placeholder="Not logged"
                    onChange={(event) =>
                      patch({ durationMinutes: nullableNumber(event.target.value) })
                    }
                  />
                </FormField>
                <FormField label="Rounds">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={draft.rounds ?? ''}
                    placeholder="Optional"
                    onChange={(event) => patch({ rounds: nullableNumber(event.target.value) })}
                  />
                </FormField>
                <FormField label="Session effort · 1–10">
                  <Input
                    type="number"
                    min="1"
                    max="10"
                    step="0.5"
                    value={draft.sessionRpe ?? ''}
                    placeholder="Optional"
                    onChange={(event) => patch({ sessionRpe: nullableNumber(event.target.value) })}
                  />
                </FormField>
                <FormField label="Readiness · 1–5" hint="1 = low · 5 = fresh">
                  <NativeSelect
                    className="w-full"
                    value={draft.readiness ?? ''}
                    onChange={(event) => patch({ readiness: nullableNumber(event.target.value) })}
                  >
                    <NativeSelectOption value="">Not logged</NativeSelectOption>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <NativeSelectOption value={value} key={value}>
                        {value}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FormField>
              </div>
              <FormField label="Session notes">
                <Textarea
                  rows={3}
                  maxLength={4000}
                  value={draft.notes}
                  placeholder="How did your strength, conditioning, or boxing quality feel?"
                  onChange={(event) => patch({ notes: event.target.value })}
                />
              </FormField>
              <FormField
                label="Plan change or skip reason"
                hint="Useful context for your next review."
              >
                <Input
                  maxLength={1500}
                  value={draft.changeReason}
                  placeholder="Short on time, moved a session, substituted equipment…"
                  onChange={(event) => patch({ changeReason: event.target.value })}
                />
              </FormField>
            </section>
          </>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="workout-editor-footer">
          {!templateMode && <span>{doneSets(draft)} working sets checked</span>}
          <div className="button-row">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={templateMode || draft.status === 'completed' ? 'default' : 'outline'}
              disabled={busy}
            >
              {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              {templateMode ? 'Save routine' : 'Save workout'}
            </Button>
            {!templateMode && draft.status !== 'completed' && draft.status !== 'skipped' && (
              <Button
                type="button"
                variant="default"
                disabled={busy}
                onClick={() => void save('completed')}
              >
                <CheckCircle2 size={16} />
                Complete workout
              </Button>
            )}
          </div>
        </div>
        {!templateMode && restEnd !== null && (
          <div className="workout-rest-timer" role="timer" aria-label="Rest timer">
            <Timer size={17} />
            <b>
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
            </b>
            <span>Rest remaining</span>
            <IconAction label="Stop rest timer" onClick={() => setRestEnd(null)}>
              <X size={17} />
            </IconAction>
          </div>
        )}
      </form>
    </TrainingDialog>
  );
}

function CheckInEditor({
  initial,
  selectedDate,
  busy,
  onClose,
  onSave,
}: {
  initial?: TrainingCheckIn;
  selectedDate: string;
  busy: boolean;
  onClose: () => void;
  onSave: (checkIn: TrainingCheckIn) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<TrainingCheckIn>(() =>
    initial
      ? structuredClone(initial)
      : {
          id: uid(),
          date: selectedDate,
          bodyWeight: null,
          waist: null,
          sleepHours: null,
          energy: null,
          soreness: null,
          boxingQuality: null,
          notes: '',
        },
  );
  const [error, setError] = useState('');
  const patch = (values: Partial<TrainingCheckIn>) =>
    setDraft((current) => ({ ...current, ...values }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !draft.notes.trim() &&
      ['bodyWeight', 'waist', 'sleepHours', 'energy', 'soreness', 'boxingQuality'].every(
        (key) => draft[key as keyof TrainingCheckIn] === null,
      )
    ) {
      setError('Add at least one measurement, rating, or note.');
      return;
    }
    if (await onSave(draft)) onClose();
  };
  return (
    <TrainingDialog title={initial ? 'Edit check-in' : 'Quick check-in'} onClose={onClose}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="training-help">
          A few consistent observations make reviews more useful. Every field is optional except the
          date.
        </p>
        <FormField label="Date">
          <Input
            required
            type="date"
            value={draft.date}
            onChange={(event) => patch({ date: event.target.value })}
          />
        </FormField>
        <div className="form-two">
          <FormField label="Body weight · lb">
            <Input
              type="number"
              min="40"
              max="1000"
              step="0.1"
              value={draft.bodyWeight ?? ''}
              onChange={(event) => patch({ bodyWeight: nullableNumber(event.target.value) })}
            />
          </FormField>
          <FormField label="Waist at navel · in">
            <Input
              type="number"
              min="10"
              max="100"
              step="0.1"
              value={draft.waist ?? ''}
              onChange={(event) => patch({ waist: nullableNumber(event.target.value) })}
            />
          </FormField>
          <FormField label="Sleep · hours">
            <Input
              type="number"
              min="0"
              max="24"
              step="0.25"
              value={draft.sleepHours ?? ''}
              onChange={(event) => patch({ sleepHours: nullableNumber(event.target.value) })}
            />
          </FormField>
          {(
            [
              { key: 'energy', label: 'Energy', hint: '1 = low · 5 = high' },
              { key: 'soreness', label: 'Soreness', hint: '1 = none · 5 = high' },
              {
                key: 'boxingQuality',
                label: 'Sport / skill quality',
                hint: '1 = poor · 5 = sharp',
              },
            ] as const
          ).map(({ key, label, hint }) => (
            <FormField key={key} label={label} hint={hint}>
              <NativeSelect
                className="w-full"
                value={draft[key] ?? ''}
                onChange={(event) => patch({ [key]: nullableNumber(event.target.value) })}
              >
                <NativeSelectOption value="">Not logged</NativeSelectOption>
                {[1, 2, 3, 4, 5].map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {value}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          ))}
        </div>
        <FormField label="Notes">
          <Textarea
            rows={3}
            maxLength={2000}
            value={draft.notes}
            onChange={(event) => patch({ notes: event.target.value })}
            placeholder="Appetite, recovery, energy, or anything affecting training."
          />
        </FormField>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="form-footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="default" disabled={busy}>
            {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}Save check-in
          </Button>
        </div>
      </form>
    </TrainingDialog>
  );
}

function ReviewCard({
  review,
  sessions,
  busy,
  mutate,
}: {
  review: TrainingReview;
  sessions: WorkoutSession[];
  busy: boolean;
  mutate: Props['mutate'];
}) {
  const actionable = review.status === 'proposed' && review.changes.length > 0;
  const stale =
    actionable &&
    review.changes.some((change) => {
      const current = sessions.find((session) => session.id === change.session.id);
      return (
        (current?.updatedAt ?? null) !== change.expectedUpdatedAt ||
        Boolean(current && !['planned', 'skipped'].includes(current.status))
      );
    });
  const exercises = (session: WorkoutSession) =>
    session.exercises.length ? (
      <ul>
        {session.exercises.map((exercise) => (
          <li key={exercise.id}>
            <b>{exercise.name}</b>
            <span>
              {exercise.targetSets} × {exercise.repMin}–{exercise.repMax} ·{' '}
              {exercise.targetRir === null ? 'RIR not set' : `${exercise.targetRir} RIR`} ·{' '}
              {exercise.restSeconds}s rest
            </span>
            <small>
              {loadLabels[exercise.loadType]}
              {exercise.notes ? ` · ${exercise.notes}` : ''}
            </small>
          </li>
        ))}
      </ul>
    ) : (
      <p>{session.notes || kindLabels[session.kind]}</p>
    );

  return (
    <Card className="panel coach-review">
      <div className="coach-review-heading">
        <div>
          <span className="training-eyebrow">
            {new Date(review.createdAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}{' '}
            · Saved review
          </span>
          <h3>{review.title}</h3>
        </div>
        <Badge
          variant={review.status === 'applied' ? 'default' : 'secondary'}
          className={`training-status training-status-${review.status === 'applied' ? 'completed' : review.status === 'dismissed' ? 'skipped' : 'planned'}`}
        >
          {review.status === 'proposed' && !review.changes.length
            ? 'Analysis'
            : review.status === 'proposed'
              ? 'For review'
              : review.status === 'applied'
                ? 'Applied'
                : 'Dismissed'}
        </Badge>
      </div>
      <div className="coach-review-summary">{review.summary}</div>
      {review.changes.length > 0 && (
        <div className="coach-changes">
          <h4>{review.status === 'applied' ? 'Applied plan changes' : 'Proposed plan changes'}</h4>
          {review.changes.map((change, index) => {
            const previous = sessions.find((session) => session.id === change.session.id);
            const next = change.session;
            return (
              <div className="coach-change" key={`${next.id}-${index}`}>
                <h5>{next.name}</h5>
                <div
                  className={`coach-change-comparison ${review.status !== 'proposed' ? 'coach-change-saved' : ''}`}
                >
                  {review.status === 'proposed' && (
                    <>
                      <div>
                        <span>Current</span>
                        <p>
                          {previous
                            ? `${todayLabel(previous.date, { weekday: 'short', month: 'short', day: 'numeric' })} · ${previous.plannedMinutes} min`
                            : 'New session'}
                        </p>
                        {previous && (
                          <small>
                            {previous.exercises.reduce(
                              (sum, exercise) => sum + exercise.targetSets,
                              0,
                            )}{' '}
                            planned sets · {statusLabels[previous.status]}
                          </small>
                        )}
                      </div>
                      <ArrowRight size={17} />
                    </>
                  )}
                  <div>
                    <span>{review.status === 'applied' ? 'Saved change' : 'Proposed'}</span>
                    <p>
                      {todayLabel(next.date, { weekday: 'short', month: 'short', day: 'numeric' })}{' '}
                      · {next.plannedMinutes} min
                    </p>
                    <small>
                      {next.exercises.reduce((sum, exercise) => sum + exercise.targetSets, 0)}{' '}
                      planned sets · {statusLabels[next.status]}
                    </small>
                  </div>
                </div>
                <p className="coach-change-reason">{change.reason}</p>
                <Collapsible className="coach-change-details">
                  <CollapsibleTrigger className="coach-change-summary">
                    <ChevronDown size={14} />
                    {review.status === 'proposed' && previous
                      ? 'Compare exercises and targets'
                      : 'See exercises and targets'}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {review.status === 'proposed' && previous && (
                      <div className="coach-exercise-comparison">
                        <h6>Current · {previous.name}</h6>
                        {exercises(previous)}
                      </div>
                    )}
                    <div className="coach-exercise-comparison">
                      <h6>
                        {review.status === 'applied' ? 'Saved change' : 'Proposed'} · {next.name}
                      </h6>
                      {exercises(next)}
                    </div>
                    {next.notes && next.exercises.length > 0 && <p>{next.notes}</p>}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            );
          })}
        </div>
      )}
      {stale && (
        <Alert variant="warning" className="coach-stale-note">
          <AlertDescription>
            Your plan changed after this review. Ask your agent for an updated proposal before
            applying it.
          </AlertDescription>
        </Alert>
      )}
      {review.status === 'proposed' && (
        <div className="coach-review-actions">
          {actionable && (
            <Button
              type="button"
              variant="default"
              disabled={busy || stale}
              onClick={() =>
                void mutate(
                  { type: 'training.review.apply', data: { id: review.id } },
                  'Training plan updated',
                )
              }
            >
              <Check size={16} />
              Apply {review.changes.length === 1 ? 'change' : `${review.changes.length} changes`}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void mutate(
                { type: 'training.review.dismiss', data: { id: review.id } },
                'Review archived',
              )
            }
          >
            {actionable ? 'Dismiss' : 'Archive review'}
          </Button>
        </div>
      )}
    </Card>
  );
}

export default function TrainingPanel({
  state,
  settings,
  selectedDate,
  onDateChange,
  mutate,
  busy,
  notify,
  onRefresh,
  onOpenAgent,
}: Props) {
  const generation = useRef(sessionLifetime()).current;
  const [tab, setTab] = useState<'week' | 'progress' | 'coach'>('week');
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [showChooser, setShowChooser] = useState(false);
  const [manageTemplates, setManageTemplates] = useState(false);
  const [checkIn, setCheckIn] = useState<TrainingCheckIn | 'new' | null>(null);
  const [skipSession, setSkipSession] = useState<WorkoutSession | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [exerciseName, setExerciseName] = useState('');
  const days = weekDates(selectedDate);
  const weekStart = days[0], weekEnd = days[6];
  const today = dateKey(new Date(), settings.timezone);
  const calendar = useResource('sessions', { from: weekStart, through: weekEnd },
    (signal) => calendarPage('sessions', weekStart, weekEnd, signal), !state);
  const progress = useResource('progress', { from: shiftDate(weekStart, -21), through: weekEnd },
    (signal) => rpc.workspace.progress({ from: shiftDate(weekStart, -21), through: weekEnd }, { signal }), !state && tab === 'progress');
  const completedPage = useRecordPage({ resource: 'sessions', order: 'recent', status: 'completed', limit: 12 }, !state && tab === 'progress');
  const checkInPage = useRecordPage({ resource: 'checkIns', order: 'recent', limit: 3 }, !state && tab === 'progress');
  const reviewPage = useRecordPage({ resource: 'reviews', order: 'recent', limit: 12 }, !state && tab === 'coach');
  const requestPage = useRecordPage({ resource: 'trainingRequests', order: 'recent', limit: 20 }, !state && tab === 'coach');
  const [templateSearch, setTemplateSearch] = useState('');
  const templatePage = useRecordPage({ resource: 'templates', search: templateSearch, limit: 20 }, !state && (showChooser || manageTemplates));
  const [exerciseSearch, setExerciseSearch] = useState('');
  const choices = useCursorResource<ExerciseChoices>('exerciseChoices', { search: exerciseSearch },
    (cursor, signal) => rpc.workspace.exerciseChoices({ search: exerciseSearch, limit: 100, cursor }, { signal }), !state && tab === 'progress');
  const weekSessions = state ? state.training.sessions.filter((session) => session.date >= weekStart && session.date <= weekEnd) : (calendar.data?.items ?? []);
  const daySessions = weekSessions.filter((session) => session.date === selectedDate);
  const stats = trainingStats(weekSessions, weekStart, weekEnd);
  const completed = state ? state.training.sessions.filter((session) => session.status === 'completed')
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)) : (completedPage.data?.items ?? []);
  const checkIns = state ? [...state.training.checkIns].sort((a, b) => b.date.localeCompare(a.date)) : (checkInPage.data?.items ?? []);
  const latestWeight = state ? checkIns.find((item) => item.bodyWeight !== null) : progress.data?.latestWeight;
  const exerciseNames = state ? [...new Set(completed.flatMap((session) => session.exercises
    .filter((exercise) => exercise.sets.some((set) => set.completed && set.kind === 'working'))
    .map((exercise) => exercise.name)))].sort() : (choices.data?.names ?? []);
  const selectedExercise = exerciseName || exerciseNames[0] || '';
  const liftHistory = useCursorResource<ExerciseHistoryPage>('exerciseHistory', { name: selectedExercise },
    (cursor, signal) => rpc.workspace.exerciseHistory({ name: selectedExercise, limit: 12, cursor }, { signal }), !state && tab === 'progress' && Boolean(selectedExercise));
  const history = selectedExercise ? state ? exerciseHistory(state.training.sessions, selectedExercise).slice(0, 12) : exerciseHistory(liftHistory.data?.sessions ?? [], selectedExercise) : [];
  const fourWeeks = state ? Array.from({ length: 4 }, (_, index) => {
    const start = shiftDate(weekStart, (index - 3) * 7);
    return { start, stats: trainingStats(state.training.sessions, start, shiftDate(start, 6)) };
  }) : (progress.data?.weekly ?? []).map((week) => ({ start: week.week, stats: week.stats }));
  const peakSessions = Math.max(1, ...fourWeeks.map((week) => week.stats.sessions));
  const reviews = state ? [...state.training.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : (reviewPage.data?.items ?? []);
  const templates = state?.training.templates ?? templatePage.data?.items ?? [];
  const requests = state ? [...state.training.requests].reverse().slice(0, 20) : (requestPage.data?.items ?? []);
  const reviewIds = [...new Set(reviews.flatMap((review) => review.changes.map((change) => change.session.id)))];
  const reviewContext = useResource('details', { sessionIds: reviewIds, revision: reviewPage.data?.revision },
    async (signal) => {
      const sessions: WorkoutSession[] = [];
      let revision = reviewPage.data!.revision;
      for (let index = 0; index < reviewIds.length; index += 25) {
        const details = await rpc.workspace.details({ sessionIds: reviewIds.slice(index, index + 25) }, { signal });
        requireRevision(revision, details.revision);
        sessions.push(...details.sessions);
      }
      return { revision, sessions };
    }, !state && tab === 'coach' && Boolean(reviewPage.data));
  const reviewSessions = state?.training.sessions ?? reviewContext.data?.sessions ?? [];
  const reviewReady = Boolean(state || (reviewPage.data && reviewContext.data && reviewPage.data.revision === reviewContext.data.revision && !reviewPage.isError && !reviewContext.isError));
  const openSession = (session: WorkoutSession) =>
    setEditor({ session: structuredClone(session), expectedUpdatedAt: session.updatedAt });
  const openSessionId = async (id: string) => {
    if (state) {
      const session = state.training.sessions.find((item) => item.id === id);
      if (session) openSession(session);
      return;
    }
    try {
      const detail = await readResource('details', () => rpc.workspace.details({ sessionIds: [id] }), generation);
      const session = detail.sessions.find((item) => item.id === id);
      if (!session) { notify('This workout is no longer saved.', true); return; }
      openSession(session);
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not open this workout.', true); }
  };
  const createBlank = (asTemplate = false) => {
    const now = new Date().toISOString();
    const template: WorkoutTemplate = {
      id: uid(),
      name: 'New workout',
      kind: 'strength',
      description: '',
      durationMinutes: settings.profile?.sessionMinutes ?? 45,
      exercises: [],
      createdAt: now,
      updatedAt: now,
    };
    const session: WorkoutSession = {
      id: uid(),
      date: selectedDate,
      name: template.name,
      kind: template.kind,
      status: 'planned',
      unit: settings.profile?.defaultWorkoutUnit ?? 'lb',
      exercises: [],
      plannedMinutes: template.durationMinutes,
      durationMinutes: null,
      rounds: null,
      sessionRpe: null,
      readiness: null,
      notes: '',
      changeReason: '',
      createdAt: now,
      updatedAt: now,
    };
    setEditor({ session, expectedUpdatedAt: null, ...(asTemplate ? { template } : {}) });
    setShowChooser(false);
    setManageTemplates(false);
  };
  const chooseTemplate = async (selected: WorkoutTemplate, edit = false) => {
    let template = selected;
    if (!state) {
      try {
        const detail = await readResource('details', () => rpc.workspace.details({ templateIds: [selected.id] }), generation);
        const saved = detail.templates.find((item) => item.id === selected.id);
        if (!saved) { notify('This routine is no longer saved.', true); return; }
        template = saved;
      } catch (error) { notify(error instanceof Error ? error.message : 'Could not open this routine.', true); return; }
    }
    setEditor({
      session: createSessionFromTemplate(template, selectedDate, {
        unit: settings.profile?.defaultWorkoutUnit ?? 'lb',
      }),
      expectedUpdatedAt: null,
      ...(edit ? { template: structuredClone(template) } : {}),
    });
    setShowChooser(false);
    setManageTemplates(false);
  };
  const saveSession = (session: WorkoutSession, expectedUpdatedAt: string | null) =>
    mutate(
      { type: 'training.session.save', data: { session, expectedUpdatedAt } },
      session.status === 'completed' ? 'Workout logged' : 'Workout saved',
    );
  const askAbout = (session: WorkoutSession) =>
    onOpenAgent(`Help me adapt ${session.name} on ${session.date}. Workout ID: ${session.id}. `);
  const activeQueries = tab === 'week' ? [calendar] : tab === 'progress'
    ? [calendar, progress, completedPage, checkInPage]
    : [calendar, reviewPage, requestPage, reviewContext];
  const activeError = activeQueries.find((query) => query.isError)?.error ??
    (tab === 'coach' && reviewPage.data && reviewContext.data && !reviewReady ? new Error('Your data changed while loading. Please retry.') : null);
  if (!state && (activeError || activeQueries.some((query) => !query.data)))
    return <ResourceStatus error={activeError} loading={!activeError} retry={() => {
      void calendar.refetch(); void progress.refetch(); completedPage.reload(); checkInPage.reload();
      choices.reload(); reviewPage.reload(); requestPage.reload(); void reviewContext.refetch();
    }} />;

  return (
    <div className="training-surface corner-ui">
      <WorkspaceHeader
        title="Your training."
        eyebrow="TRAIN WITH ROOM FOR LIFE"
        description="Show up, record the work, and adjust as you go."
        actions={
          <>
            <div className="date-control">
              <IconAction
                label="Previous training week"
                onClick={() => onDateChange(shiftDate(selectedDate, -7))}
              >
                <ChevronLeft size={17} />
              </IconAction>
              <span>
                {todayLabel(weekStart, { month: 'short', day: 'numeric' })} –{' '}
                {todayLabel(weekEnd, { month: 'short', day: 'numeric' })}
              </span>
              <IconAction
                label="Next training week"
                onClick={() => onDateChange(shiftDate(selectedDate, 7))}
              >
                <ChevronRight size={17} />
              </IconAction>
            </div>
            <Button
              type="button"
              variant="default"
              onClick={() => setShowChooser(true)}
              disabled={busy}
            >
              <Plus size={17} />
              Add workout
            </Button>
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(val) => {
          if (val) setTab(val as 'week' | 'progress' | 'coach');
        }}
      >
        <div className="training-toolbar">
          <TabsList className="training-tabs" aria-label="Training views">
            <TabsTrigger value="week" id="training-tab-week">
              <CalendarDays size={17} />
              Week
            </TabsTrigger>
            <TabsTrigger value="progress" id="training-tab-progress">
              <TrendingUp size={17} />
              Progress
            </TabsTrigger>
            <TabsTrigger value="coach" id="training-tab-coach">
              <Sparkles size={17} />
              Coach
              {reviews.some((review) => review.status === 'proposed') && (
                <span className="training-unread-dot" aria-label="New review" />
              )}
            </TabsTrigger>
          </TabsList>
          <Button type="button" variant="ghost" size="sm" onClick={() => onDateChange(today)}>
            This week
          </Button>
        </div>

        <div className="training-metrics" aria-label="Selected week training totals">
          <div>
            <span>Completed sessions</span>
            <strong>{stats.sessions}</strong>
            <small>Strength, boxing & conditioning</small>
          </div>
          <div>
            <span>Minutes trained</span>
            <strong>{n(stats.minutes)}</strong>
            <small>Actual time you logged</small>
          </div>
          <div>
            <span>Working sets</span>
            <strong>{stats.workingSets}</strong>
            <small>Completed sets this week</small>
          </div>
          <div>
            <span>Average effort</span>
            <strong>
              {stats.averageRpe === null ? '—' : n(stats.averageRpe, 1)}
              {stats.averageRpe !== null && <em>/ 10</em>}
            </strong>
            <small>From logged session ratings</small>
          </div>
        </div>

        <TabsContent value="week" id="training-panel-week">
          <div className="training-week-strip" aria-label="Training days">
            {days.map((day) => {
              const sessions = weekSessions.filter((session) => session.date === day);
              const active = sessions.filter((session) => session.status !== 'skipped');
              const complete =
                active.length > 0 && active.every((session) => session.status === 'completed');
              const Icon = kindIcon(
                active.find((session) => session.kind !== 'recovery')?.kind ?? 'recovery',
              );
              return (
                <Button
                  variant={day === selectedDate ? 'default' : 'secondary'}
                  className={`training-day-button ${day === selectedDate ? 'selected' : ''} ${day === today ? 'is-today' : ''}`}
                  key={day}
                  onClick={() => onDateChange(day)}
                  aria-pressed={day === selectedDate}
                  aria-label={`${todayLabel(day)}: ${sessions.length ? sessions.map((session) => `${session.name}, ${statusLabels[session.status]}`).join('; ') : 'No workout planned'}`}
                >
                  <span>{todayLabel(day, { weekday: 'short' })}</span>
                  <strong>{Number(day.slice(-2))}</strong>
                  <Icon size={18} />
                  <small>
                    {complete
                      ? 'Done'
                      : active.length
                        ? kindLabels[active[0].kind]
                        : sessions.length
                          ? 'Skipped'
                          : 'Open'}
                  </small>
                </Button>
              );
            })}
          </div>

          <div className="training-week-layout">
            <div className="training-day-content">
              <div className="section-heading">
                <h2>{todayLabel(selectedDate)}</h2>
                <span>
                  {daySessions.length} {daySessions.length === 1 ? 'session' : 'sessions'}
                </span>
              </div>
              {daySessions.length ? (
                daySessions.map((session) => {
                  const Icon = kindIcon(session.kind);
                  const loggedSets = doneSets(session);
                  return (
                    <Card className="panel workout-card" key={session.id}>
                      <div className="workout-card-heading">
                        <span className="workout-kind-icon">
                          <Icon size={22} />
                        </span>
                        <div>
                          <span className="training-eyebrow">{kindLabels[session.kind]}</span>
                          <h3>{session.name}</h3>
                        </div>
                        <Badge
                          variant={session.status === 'completed' ? 'default' : 'secondary'}
                          className={`training-status training-status-${session.status}`}
                        >
                          {statusLabels[session.status]}
                        </Badge>
                      </div>
                      <div className="workout-card-facts">
                        <span>
                          <Clock3 size={15} />
                          {session.status === 'completed'
                            ? session.durationMinutes === null
                              ? 'Time not logged'
                              : `${session.durationMinutes} min logged`
                            : `${session.plannedMinutes} min planned`}
                        </span>
                        {session.exercises.length > 0 && (
                          <span>
                            <Dumbbell size={15} />
                            {session.status === 'completed'
                              ? `${loggedSets} working sets`
                              : `${session.exercises.length} exercises`}
                          </span>
                        )}
                        {session.sessionRpe !== null && <span>Effort {session.sessionRpe}/10</span>}
                      </div>
                      {session.exercises.length > 0 && (
                        <ul className="workout-preview-list">
                          {session.exercises.slice(0, 4).map((exercise) => (
                            <li key={exercise.id}>
                              <span>{exercise.name}</span>
                              <b>
                                {exercise.targetSets} × {exercise.repMin}–{exercise.repMax}
                              </b>
                            </li>
                          ))}
                          {session.exercises.length > 4 && (
                            <li className="workout-preview-more">
                              + {session.exercises.length - 4} more exercises
                            </li>
                          )}
                        </ul>
                      )}
                      {session.notes && <p className="workout-card-note">{session.notes}</p>}
                      {session.changeReason && (
                        <p className="workout-change-note">
                          <span>Plan update</span>
                          {session.changeReason}
                        </p>
                      )}
                      <div className="workout-card-actions">
                        <Button
                          type="button"
                          variant={
                            session.status === 'planned' || session.status === 'in_progress'
                              ? 'default'
                              : 'outline'
                          }
                          disabled={busy}
                          onClick={() => {
                            const copy = structuredClone(session);
                            if (copy.status === 'planned') copy.status = 'in_progress';
                            setEditor({ session: copy, expectedUpdatedAt: session.updatedAt });
                          }}
                        >
                          {session.status === 'planned' ? <Play size={16} /> : <Pencil size={16} />}
                          {session.status === 'planned'
                            ? session.kind === 'recovery'
                              ? 'Log recovery'
                              : 'Start workout'
                            : session.status === 'in_progress'
                              ? 'Continue logging'
                              : 'View / edit'}
                        </Button>
                        {session.status === 'planned' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => openSession(session)}
                          >
                            <CalendarDays size={16} />
                            Move / edit
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => askAbout(session)}
                        >
                          <Sparkles size={16} />
                          Adapt
                        </Button>
                        {session.status === 'planned' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSkipSession(session);
                              setSkipReason('');
                            }}
                          >
                            <SkipForward size={16} />
                            Skip
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })
              ) : (
                <Card className="panel">
                  <EmptyState
                    title="Some room in your day"
                    action={
                      <Button type="button" variant="outline" onClick={() => setShowChooser(true)}>
                        <Plus size={16} />
                        Plan a workout
                      </Button>
                    }
                  >
                    Add a session, move one here, or leave the day open for recovery.
                  </EmptyState>
                </Card>
              )}
            </div>

            <aside className="training-week-aside">
              <section className="training-routine-note">
                <Dumbbell size={24} strokeWidth={1.6} />
                <h3>A plan you can adjust.</h3>
                <p>
                  Build sessions around your goals and available time. Save routines you want to
                  repeat, and use your log to guide the next step.
                </p>
                <div className="training-conventions">
                  <span>
                    <Check size={15} />
                    Dumbbells recorded per hand
                  </span>
                  <span>
                    <Check size={15} />
                    Choose targets for each exercise
                  </span>
                  <span>
                    <Check size={15} />
                    Completed work stays in your history
                  </span>
                </div>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="inline-link p-0 h-auto font-medium"
                  onClick={() => setManageTemplates(true)}
                >
                  Manage routines <ArrowRight size={16} />
                </Button>
              </section>
              <section className="training-coach-nudge">
                <Sparkles size={20} />
                <h3>Life changed the plan?</h3>
                <p>
                  Tell your agent what changed. Review a practical adjustment using your profile,
                  saved workouts, and results.
                </p>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="inline-link p-0 h-auto font-medium"
                  onClick={() => onOpenAgent()}
                >
                  Open my agent <ArrowRight size={16} />
                </Button>
              </section>
            </aside>
          </div>
        </TabsContent>

        <TabsContent value="progress" id="training-panel-progress">
          <div className="training-progress-grid">
            <Card className="panel training-progress-card">
              <div className="section-heading">
                <h2>Four weeks of work</h2>
                <span>Completed sessions</span>
              </div>
              <div className="training-week-bars">
                {fourWeeks.map((week) => (
                  <div className="training-week-bar-row" key={week.start}>
                    <span>{todayLabel(week.start, { month: 'short', day: 'numeric' })}</span>
                    <div className="training-week-bar-track">
                      <div style={{ width: `${(week.stats.sessions / peakSessions) * 100}%` }} />
                    </div>
                    <b>{week.stats.sessions}</b>
                  </div>
                ))}
              </div>
              <p className="training-help">
                Only completed strength, boxing, and conditioning sessions appear here. Plans and
                skipped sessions do not count as training.
              </p>
            </Card>
            <Card className="panel training-progress-card training-checkin-summary">
              <div className="section-heading">
                <h2>Recovery & measurements</h2>
                <Button type="button" variant="outline" size="sm" onClick={() => setCheckIn('new')}>
                  <Plus size={16} />
                  Check in
                </Button>
              </div>
              {latestWeight ? (
                <div className="training-weight-metric">
                  <strong>
                    {n(latestWeight.bodyWeight!, 1)}
                    <small> lb</small>
                  </strong>
                  <span>
                    Latest logged weight ·{' '}
                    {todayLabel(latestWeight.date, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
              ) : (
                <p className="training-help">
                  Log weight, waist, sleep, and how training feels when you have something useful to
                  record.
                </p>
              )}
              {checkIns.length > 0 && (
                <div className="training-checkin-list">
                  {checkIns.slice(0, 3).map((item) => (
                    <Button
                      variant="ghost"
                      className="training-checkin-button"
                      key={item.id}
                      onClick={() => setCheckIn(item)}
                    >
                      <span>
                        <b>{todayLabel(item.date, { month: 'short', day: 'numeric' })}</b>
                        <small>
                          {[
                            item.bodyWeight !== null ? `${item.bodyWeight} lb` : '',
                            item.waist !== null ? `${item.waist} in waist` : '',
                            item.energy !== null ? `Energy ${item.energy}/5` : '',
                            item.sleepHours !== null ? `${item.sleepHours}h sleep` : '',
                          ]
                            .filter(Boolean)
                            .join(' · ') || 'Notes & ratings'}
                        </small>
                      </span>
                      <Pencil size={15} />
                    </Button>
                  ))}
                </div>
              )}
              {!state && <ResourcePaging {...checkInPage.paging} />}
            </Card>
          </div>
          <Card className="panel training-progress-card training-lift-history">
            <div className="section-heading">
              <h2>Lift history</h2>
              {!state && <><Input aria-label="Find an exercise in your history" value={exerciseSearch} onChange={(event) => setExerciseSearch(event.target.value)} />{(!choices.data || choices.isError) && <ResourceStatus error={choices.error} loading={choices.isPending} retry={choices.reload} />}<ResourcePaging {...choices.paging} /></>}
              {(exerciseNames.length > 0 || selectedExercise) && (
                <FieldLabel className="field">
                  <span className="sr-only">Exercise history</span>
                  <NativeSelect
                    value={selectedExercise}
                    onChange={(event) => setExerciseName(event.target.value)}
                    aria-label="Exercise history"
                  >
                    {selectedExercise && !exerciseNames.includes(selectedExercise) && <NativeSelectOption value={selectedExercise}>{selectedExercise}</NativeSelectOption>}
                    {exerciseNames.map((name) => (
                      <NativeSelectOption key={name} value={name}>
                        {name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </FieldLabel>
              )}
            </div>
            {!state && selectedExercise && (!liftHistory.data || liftHistory.isError) && <ResourceStatus error={liftHistory.error} loading={liftHistory.isPending} retry={liftHistory.reload} />}
            {(!state && ((!choices.data || choices.isError) || (selectedExercise && (!liftHistory.data || liftHistory.isError)))) ? null : history.length ? (
              <div className="training-history-scroll">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Recorded working sets</TableHead>
                      <TableHead>Load convention</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((entry, entryIndex) => (
                      <TableRow key={`${entry.sessionId}-${entryIndex}`}>
                        <TableCell>
                          <Button
                            type="button"
                            variant="link"
                            className="p-0 h-auto font-medium"
                            onClick={() => void openSessionId(entry.sessionId)}
                          >
                            {todayLabel(entry.date, { month: 'short', day: 'numeric' })}
                          </Button>
                        </TableCell>
                        <TableCell>
                          {entry.sets.map((set) => (
                            <span className="training-set-chip" key={set.id}>
                              {entry.loadType === 'bodyweight' && !set.weight
                                ? 'BW'
                                : `${set.weight ?? '—'} ${entry.unit}`}{' '}
                              × {set.reps}
                              {set.rir !== null && <small> · {set.rir} RIR</small>}
                            </span>
                          ))}
                        </TableCell>
                        <TableCell>{loadLabels[entry.loadType]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <EmptyState title="Your first session sets the baseline">
                Complete a workout with checked working sets to compare load, reps, and effort over
                time.
              </EmptyState>
            )}
            {!state && selectedExercise && <ResourcePaging {...liftHistory.paging} />}
          </Card>
          <Card className="panel training-progress-card training-session-history">
            <div className="section-heading">
              <h2>Recent sessions</h2>
              <span>{state ? completed.length : (progress.data?.completedCount ?? '…')} completed</span>
            </div>
            {completed.length ? (
              completed.slice(0, 12).map((session) => {
                const Icon = kindIcon(session.kind);
                return (
                  <Button
                    variant="ghost"
                    className="training-history-row"
                    key={session.id}
                    onClick={() => openSession(session)}
                  >
                    <Icon size={19} />
                    <span>
                      <b>{session.name}</b>
                      <small>
                        {todayLabel(session.date)} ·{' '}
                        {session.durationMinutes === null
                          ? 'Time not logged'
                          : `${session.durationMinutes} min`}
                        {doneSets(session) ? ` · ${doneSets(session)} working sets` : ''}
                      </small>
                    </span>
                    <ChevronRight size={17} />
                  </Button>
                );
              })
            ) : (
              <p className="training-help">
                Completed sessions will appear here when you log your first workout.
              </p>
            )}
            {!state && <ResourcePaging {...completedPage.paging} />}
          </Card>
        </TabsContent>

        <TabsContent value="coach" id="training-panel-coach">
          <div className="onboarding-nudge">
            <div>
              <h2>A useful next step.</h2>
              <p>
                Ask your independent agent to build a routine, adapt a session, or review your
                progress.
              </p>
            </div>
            <Button
              type="button"
              variant="default"
              onClick={() =>
                onOpenAgent(
                  'Review my saved training and suggest a practical next step based on my goals.',
                )
              }
            >
              <Sparkles size={16} />
              Open my agent
            </Button>
          </div>
          {reviewReady && reviews.length > 0 && (
            <>
              <div className="section-heading">
                <h2>Saved training reviews</h2>
                <span>{reviews.length}</span>
              </div>
              <div className="coach-reviews">
                {reviews.slice(0, 12).map((review) => (
                  <ReviewCard
                    key={review.id}
                    review={review}
                    sessions={reviewSessions}
                    busy={busy}
                    mutate={mutate}
                  />
                ))}
              </div>
            </>
          )}
          {!state && <ResourcePaging {...reviewPage.paging} />}
          {requests.length > 0 && (
            <section className="profile-section">
              <h2>Saved coaching notes</h2>
              {requests.map((request) => (
                  <div key={request.id}>
                    <small>
                      {request.date} · {request.status}
                    </small>
                    <p>{request.prompt}</p>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="inline-link p-0 h-auto font-medium"
                      onClick={() => onOpenAgent(request.prompt)}
                    >
                      Use in a new request <ArrowRight size={15} />
                    </Button>
                  </div>
                ))}
            </section>
          )}
          {!state && <ResourcePaging {...requestPage.paging} />}
        </TabsContent>
      </Tabs>

      {showChooser && (
        <TrainingDialog
          title={`Add workout · ${todayLabel(selectedDate, { month: 'short', day: 'numeric' })}`}
          onClose={() => setShowChooser(false)}
        >
          <div className="training-template-picker">
            <p className="training-help">Start from a routine, then make this session your own.</p>
            {!state && <><Input aria-label="Search routines" value={templateSearch} onChange={(event) => setTemplateSearch(event.target.value)} />{(!templatePage.data || templatePage.isError) && <ResourceStatus error={templatePage.error} loading={templatePage.isPending} retry={templatePage.reload} />}<ResourcePaging {...templatePage.paging} /></>}
            {templates.map((template) => {
              const Icon = kindIcon(template.kind);
              return (
                <Button
                  variant="secondary"
                  className="training-template-choice"
                  key={template.id}
                  onClick={() => chooseTemplate(template)}
                >
                  <Icon size={22} />
                  <span>
                    <b>{template.name}</b>
                    <small>
                      {template.durationMinutes} min ·{' '}
                      {template.exercises.length
                        ? `${template.exercises.length} exercises`
                        : kindLabels[template.kind]}
                    </small>
                  </span>
                  <Plus size={18} />
                </Button>
              );
            })}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => createBlank()}
            >
              <Plus size={17} />
              Blank workout
            </Button>
          </div>
        </TrainingDialog>
      )}

      {manageTemplates && (
        <TrainingDialog title="Your reusable routines" onClose={() => setManageTemplates(false)}>
          <div className="training-template-picker">
            <p className="training-help">
              Routine edits apply when you add future sessions. Existing workouts keep their own
              targets and logs.
            </p>
            {!state && <><Input aria-label="Search routines" value={templateSearch} onChange={(event) => setTemplateSearch(event.target.value)} />{(!templatePage.data || templatePage.isError) && <ResourceStatus error={templatePage.error} loading={templatePage.isPending} retry={templatePage.reload} />}<ResourcePaging {...templatePage.paging} /></>}
            {templates.map((template) => (
              <Button
                variant="secondary"
                className="training-template-choice"
                key={template.id}
                onClick={() => chooseTemplate(template, true)}
              >
                <Dumbbell size={21} />
                <span>
                  <b>{template.name}</b>
                  <small>
                    {template.durationMinutes} min · {template.exercises.length} exercises
                  </small>
                </span>
                <Pencil size={17} />
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => createBlank(true)}
            >
              <Plus size={17} />
              New routine
            </Button>
          </div>
        </TrainingDialog>
      )}

      {editor && (
        <SessionEditor
          key={`${editor.session.id}-${editor.template ? 'template' : 'session'}`}
          editor={editor}
          history={state?.training.sessions}
          busy={busy}
          onClose={() => setEditor(null)}
          onSave={saveSession}
          onSaveTemplate={(template) =>
            mutate({ type: 'training.template.save', data: template }, 'Routine saved')
          }
        />
      )}

      {checkIn && (
        <CheckInEditor
          initial={checkIn === 'new' ? undefined : checkIn}
          selectedDate={selectedDate}
          busy={busy}
          onClose={() => setCheckIn(null)}
          onSave={(value) =>
            mutate({ type: 'training.checkin.save', data: value }, 'Check-in saved')
          }
        />
      )}

      {skipSession && (
        <TrainingDialog title={`Skip ${skipSession.name}`} onClose={() => setSkipSession(null)}>
          <form
            className="dialog-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await saveSession(
                  {
                    ...skipSession,
                    status: 'skipped',
                    changeReason: skipReason,
                    updatedAt: new Date().toISOString(),
                  },
                  skipSession.updatedAt,
                )
              )
                setSkipSession(null);
            }}
          >
            <p className="training-help">
              A skipped session stays in your plan so a future review has the full picture.
            </p>
            <FormField label="What changed?">
              <Textarea
                rows={3}
                required
                minLength={2}
                maxLength={1500}
                value={skipReason}
                onChange={(event) => setSkipReason(event.target.value)}
                placeholder="Busy day, fatigue, travel…"
              />
            </FormField>
            <div className="form-footer">
              <Button type="button" variant="ghost" onClick={() => setSkipSession(null)}>
                Keep workout
              </Button>
              <Button type="submit" variant="default" disabled={busy}>
                <SkipForward size={16} />
                Mark skipped
              </Button>
            </div>
          </form>
        </TrainingDialog>
      )}
    </div>
  );
}
