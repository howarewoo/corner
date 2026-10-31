import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { ChevronDown, ChevronUp, Dumbbell } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
  useSidebar,
} from '@packages/ui';
import { WorkoutSessionSchema } from '@packages/training/workouts';
import type { WorkoutSession } from '@packages/training/types';
import type { AppState } from '@packages/workspace/types';
import { readResource, rpc, sessionLifetime } from '../rpc';
import { useRecordPage } from '../features/workspace/resources';
import type { Mutate, Notify } from '../features/workspace/types';
import { SessionEditor, type EditorState } from './training-panel';
import { WorkoutClock } from './workout-timing';

function ActiveWorkoutEditor(props: ComponentProps<typeof SessionEditor>) {
  // A breakpoint change remounts the overlay with the latest draft. Hold that
  // seed stable during ordinary typing, autosaves, and collapse/resume.
  const [editor] = useState(props.editor);
  return <SessionEditor {...props} editor={editor} />;
}

type Recovery = {
  session: WorkoutSession;
  expectedUpdatedAt: string | null;
  prefillEdits: Record<string, boolean>;
  pendingSave?: WorkoutSession;
};
const comparable = (session: WorkoutSession) => {
  const parsed = WorkoutSessionSchema.safeParse(session);
  return JSON.stringify({ ...(parsed.success ? parsed.data : session), updatedAt: '' });
};
function recover(key: string, saved: WorkoutSession): Recovery | undefined {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    const candidate = raw?.session as WorkoutSession | undefined;
    if (!candidate || !Array.isArray(candidate.exercises)) return;
    const checked = WorkoutSessionSchema.safeParse({
      ...candidate,
      name: candidate.name === '' ? saved.name : candidate.name,
      exercises: candidate.exercises.map((exercise) => ({
        ...exercise,
        name: exercise.name === '' ? 'Draft exercise' : exercise.name,
        repMin: exercise.repMin === null ? null : 1,
        repMax: exercise.repMax === null ? null : 200,
        sets: Array.isArray(exercise.sets)
          ? exercise.sets.map((set) => ({ ...set, completed: false }))
          : null,
      })),
    });
    if (
      !checked.success ||
      candidate.id !== saved.id ||
      candidate.status !== 'in_progress' ||
      typeof raw.expectedUpdatedAt !== 'string' ||
      !raw.prefillEdits ||
      Object.values(raw.prefillEdits).some((value) => typeof value !== 'boolean')
    )
      return;
    let pendingSave: WorkoutSession | undefined;
    if (raw.pendingSave != null) {
      const pending = WorkoutSessionSchema.safeParse(raw.pendingSave);
      if (
        !pending.success ||
        pending.data.id !== saved.id ||
        !['in_progress', 'completed'].includes(pending.data.status)
      )
        return;
      pendingSave = pending.data;
    }
    const confirmed = comparable(saved) === comparable(pendingSave ?? candidate);
    return {
      session: candidate,
      expectedUpdatedAt: confirmed ? saved.updatedAt : raw.expectedUpdatedAt,
      prefillEdits: raw.prefillEdits,
      pendingSave: confirmed ? undefined : pendingSave,
    };
  } catch {
    return;
  }
}

export function useActiveWorkout({
  state,
  accountKey,
  busy,
  mutate,
  notify,
  view,
}: {
  state?: AppState;
  accountKey: string;
  busy: boolean;
  mutate: Mutate;
  notify: Notify;
  view: string;
}) {
  const { isMobile } = useSidebar();
  const records = useRecordPage(
    { resource: 'sessions', status: 'in_progress', order: 'recent', limit: 100 },
    !state,
  );
  const sessions = state
    ? state.training.sessions.filter((session) => session.status === 'in_progress')
    : records.data?.items;
  const storageKey = `corner-active-workout:${accountKey}`;
  const generation = useRef(sessionLifetime()).current;
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<WorkoutSession | null>(null);
  const [expanded, setExpanded] = useState(false);
  const expected = useRef<string | null>(null);
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const lock = useRef(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const savedContent = useRef('');
  const attempted = useRef('');
  const finishedId = useRef<string | null>(null);
  // Keep the submitted write separate from newer editable content until its
  // outcome/version is known, including across reload during a network outage.
  const pendingSave = useRef<WorkoutSession | undefined>(undefined);
  const recoveryDraft = useRef<Pick<Recovery, 'session' | 'prefillEdits'> | null>(null);
  const finish = useRef<() => void>(() => {});
  const resume = useRef<HTMLButtonElement>(null);
  const remember = useCallback(
    (session: WorkoutSession, prefillEdits: Record<string, boolean>) => {
      recoveryDraft.current = { session, prefillEdits };
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            session,
            expectedUpdatedAt: expected.current,
            prefillEdits,
            pendingSave: pendingSave.current,
          }),
        );
      } catch {
        /* Server save remains available when browser storage is blocked. */
      }
    },
    [storageKey],
  );
  const checkpoint = useCallback(() => {
    const latest = recoveryDraft.current;
    if (latest) remember(latest.session, latest.prefillEdits);
  }, [remember]);
  const open = useCallback(
    (saved: WorkoutSession, show: boolean) => {
      const recovery = recover(storageKey, saved);
      expected.current = recovery?.expectedUpdatedAt ?? saved.updatedAt;
      pendingSave.current = recovery?.pendingSave;
      savedContent.current = comparable(saved);
      const session = recovery?.session ?? structuredClone(saved);
      remember(session, recovery?.prefillEdits ?? {});
      setEditor({
        session,
        expectedUpdatedAt: expected.current,
        prefillEdits: recovery?.prefillEdits,
      });
      setDraft(session);
      setEdits(recovery?.prefillEdits ?? {});
      setExpanded(show);
    },
    [storageKey, remember],
  );
  useEffect(() => {
    if (!lock.current && !editor && sessions?.[0] && sessions[0].id !== finishedId.current)
      open(sessions[0], false);
  }, [sessions, editor, open]);
  useEffect(() => {
    setExpanded(false);
  }, [view]);
  const onDraft = useCallback(
    (session: WorkoutSession, prefillEdits: Record<string, boolean>) => {
      setDraft(session);
      setEdits(prefillEdits);
      remember(session, prefillEdits);
    },
    [remember],
  );
  const onFinishReady = useCallback((callback: () => void) => {
    finish.current = callback;
  }, []);
  const readSaved = async (id: string) => {
    if (state) return null;
    const details = await readResource(
      'details',
      () => rpc.workspace.details({ sessionIds: [id] }),
      generation,
    );
    const saved = details.sessions.find((session) => session.id === id);
    if (!saved) throw new Error('This workout is no longer saved. Your draft is still available.');
    return saved;
  };
  const persist = async (session: WorkoutSession) => {
    if (busy || lock.current) return false;
    lock.current = true;
    setSaving(true);
    try {
      if (pendingSave.current) {
        let saved = await readSaved(session.id);
        // A different version is safe only when it contains our submitted write.
        if (
          saved &&
          comparable(saved) !== comparable(pendingSave.current) &&
          saved.updatedAt !== expected.current
        )
          throw new Error(
            'This workout changed elsewhere. Your local draft is kept; reload the saved version before replacing it.',
          );
        if (saved && comparable(saved) !== comparable(pendingSave.current)) {
          // Reading the old version does not prove the earlier request is over.
          // Settle that same snapshot against its original version before any
          // newer content. Both copies contend on the server's version check;
          // after one commits, neither can later overwrite the newer draft.
          await mutate({
            type: 'training.session.save',
            data: {
              session: pendingSave.current,
              expectedUpdatedAt: expected.current,
            },
          });
          saved = await readSaved(session.id);
          if (!saved || comparable(saved) !== comparable(pendingSave.current))
            throw new Error('The earlier save is not confirmed. Your local draft is kept.');
        }
        if (saved) expected.current = saved.updatedAt;
        pendingSave.current = undefined;
        checkpoint();
      }
      pendingSave.current = structuredClone(session);
      checkpoint();
      const ok = await mutate(
        { type: 'training.session.save', data: { session, expectedUpdatedAt: expected.current } },
        session.status === 'completed' ? 'Workout logged' : undefined,
      );
      const confirmed = session.status === 'completed' && ok ? null : await readSaved(session.id);
      if ((!ok && !confirmed) || (confirmed && comparable(confirmed) !== comparable(session))) {
        setSaveFailed(true);
        return false;
      }
      if (!ok) notify('Workout save confirmed.');
      expected.current = confirmed?.updatedAt ?? session.updatedAt;
      savedContent.current = comparable(session);
      pendingSave.current = undefined;
      checkpoint();
      setSaveFailed(false);
      if (session.status === 'completed') {
        finishedId.current = session.id;
        setEditor(null);
        setDraft(null);
        setExpanded(false);
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          /* Storage can be unavailable. */
        }
      }
      return true;
    } catch (error) {
      setSaveFailed(true);
      notify(
        error instanceof Error
          ? error.message
          : 'Could not save your workout. Your draft is still available.',
        true,
      );
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  const activate = async (session: WorkoutSession, expectedUpdatedAt: string | null) => {
    if (editor) {
      setExpanded(true);
      if (editor.session.id !== session.id)
        notify('Resume or finish your active workout before starting another.', true);
      return editor.session.id === session.id;
    }
    if (busy || lock.current) return false;
    if (!sessions) {
      notify('Wait for your active workout to load before starting another.', true);
      return false;
    }
    if (sessions[0]) {
      open(sessions[0], true);
      return sessions[0].id === session.id;
    }
    lock.current = true;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const next: WorkoutSession = {
        ...session,
        status: 'in_progress',
        timing: { startedAt: now, rests: [] },
        updatedAt: now,
      };
      if (
        !(await mutate({
          type: 'training.session.save',
          data: { session: next, expectedUpdatedAt },
        }))
      ) {
        const confirmed = await readSaved(next.id).catch(() => null);
        if (!confirmed || comparable(confirmed) !== comparable(next)) return false;
        notify('Workout start confirmed.');
      }
      // Show the active workout even if the follow-up read is temporarily unavailable.
      open(next, true);
      savedContent.current = comparable(next);
      pendingSave.current = next;
      checkpoint();
      const saved = await readSaved(next.id);
      if (saved && comparable(saved) !== comparable(next))
        throw new Error('This workout changed elsewhere. Your local draft is kept.');
      expected.current = saved?.updatedAt ?? next.updatedAt;
      pendingSave.current = undefined;
      checkpoint();
      savedContent.current = comparable(next);
      return true;
    } catch (error) {
      if (pendingSave.current) setSaveFailed(true);
      notify(error instanceof Error ? error.message : 'Could not open your workout.', true);
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  };
  useEffect(() => {
    if (!draft || busy || saving || draft.status !== 'in_progress') return;
    const serialized = comparable(draft);
    if (
      (serialized === savedContent.current && !pendingSave.current) ||
      serialized === attempted.current ||
      !WorkoutSessionSchema.safeParse(draft).success
    )
      return;
    const timer = setTimeout(() => {
      attempted.current = serialized;
      void persist(draft);
    }, 800);
    return () => clearTimeout(timer);
  }, [draft, busy, saving]);
  useEffect(() => {
    if (draft && !saving) remember(draft, edits);
  }, [draft, edits, saving, remember]);

  const total =
    draft?.exercises.reduce(
      (sum, exercise) => sum + exercise.sets.filter((set) => set.kind === 'working').length,
      0,
    ) ?? 0;
  const done =
    draft?.exercises.reduce(
      (sum, exercise) =>
        sum + exercise.sets.filter((set) => set.completed && set.kind === 'working').length,
      0,
    ) ?? 0;
  const Title = isMobile ? DrawerTitle : DialogTitle;
  const Description = isMobile ? DrawerDescription : DialogDescription;
  const content =
    editor && draft ? (
      <>
        <header className="active-workout-header">
          <div>
            <Title className="active-workout-title">{draft.name}</Title>
            <Description className="active-workout-description">
              {done}/{total} working sets · <WorkoutClock timing={draft.timing} />
            </Description>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(false)}
            aria-label="Collapse workout"
          >
            <ChevronDown size={16} />
            Collapse
          </Button>
          <Button size="sm" disabled={busy || saving} onClick={() => finish.current()}>
            Finish workout
          </Button>
        </header>
        {saveFailed && (
          <div className="active-workout-save-state" role="status">
            Your draft is kept in this browser.{' '}
            <Button
              variant="link"
              size="sm"
              disabled={busy || saving}
              onClick={() => draft && void persist(draft)}
            >
              Retry save
            </Button>
          </div>
        )}
        <div className="active-workout-body">
          <ActiveWorkoutEditor
            key={editor.session.id}
            editor={{ ...editor, session: draft, prefillEdits: edits }}
            busy={busy || saving}
            history={state?.training.sessions}
            onClose={() => setExpanded(false)}
            onSave={(session) => persist(session)}
            onSaveTemplate={async () => false}
            active={{ expanded, onDraft, onFinishReady }}
          />
        </div>
      </>
    ) : null;
  const surface =
    editor && draft ? (
      <>
        <div className="active-workout-dock" aria-label="Active workout">
          <Button
            ref={resume}
            variant="secondary"
            className="active-workout-resume"
            onClick={() => setExpanded(true)}
            aria-label={`Resume ${draft.name}`}
            aria-expanded={expanded}
          >
            <Dumbbell size={20} />
            <span>
              <strong>{draft.name}</strong>
              <small>
                {done}/{total} sets · <WorkoutClock timing={draft.timing} />
                {saveFailed ? ' · Not saved' : saving ? ' · Saving…' : ''}
              </small>
            </span>
            <ChevronUp size={18} />
          </Button>
        </div>
        {isMobile ? (
          <Drawer open={expanded} onOpenChange={setExpanded} showSwipeHandle>
            <DrawerContent
              keepMounted
              className="corner-ui active-workout-overlay active-workout-sheet"
              finalFocus={resume}
            >
              {content}
            </DrawerContent>
          </Drawer>
        ) : (
          <Dialog open={expanded} onOpenChange={setExpanded}>
            <DialogContent
              keepMounted
              showCloseButton={false}
              className="corner-ui active-workout-overlay active-workout-dialog"
              finalFocus={resume}
            >
              {content}
            </DialogContent>
          </Dialog>
        )}
      </>
    ) : null;
  return { activate, surface, hasActive: Boolean(editor) };
}
