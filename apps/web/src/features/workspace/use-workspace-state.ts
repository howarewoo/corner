import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Mutation } from '@packages/shared/types';
import { applyMutation } from '@packages/shared/domain';
import { createToastManager } from '@packages/ui';
import type { ApiPayload, CornerAppProps } from './types';
import { newId } from './utils';

export function useWorkspaceState({
  initialState,
  initialRevision = 0,
  preview,
  onSessionExpired,
}: Pick<CornerAppProps, 'initialState' | 'initialRevision' | 'preview' | 'onSessionExpired'>) {
  const [state, setState] = useState<AppState>(initialState);
  const [revision, setRevision] = useState(initialRevision);
  const [notifications] = useState(() => createToastManager());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!preview);
  const [hydrated, setHydrated] = useState(preview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const mutationLock = useRef(false);
  const refreshLock = useRef(false);
  const latestRevision = useRef(initialRevision);
  const notify = useCallback(
    (message: string, error = false) => {
      notifications.add({
        id: 'workspace-notice',
        title: message,
        type: error ? 'error' : 'success',
        priority: error ? 'high' : 'low',
      });
    },
    [notifications],
  );
  const readState = useCallback(async () => {
    if (preview || refreshLock.current || mutationLock.current) return;
    refreshLock.current = true;
    setLoading(true);
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      const payload = (await response.json()) as ApiPayload;
      if (response.status === 401 && payload.code === 'SIGN_IN_REQUIRED') {
        onSessionExpired?.();
        return;
      }
      if (!response.ok || !payload.state)
        throw new Error(
          typeof payload.error === 'string'
            ? payload.error
            : 'Could not load your saved data. Please try again.',
        );
      if ((payload.revision ?? 0) >= latestRevision.current) {
        latestRevision.current = payload.revision ?? 0;
        setRevision(latestRevision.current);
        setState(payload.state);
        setAiAvailable(Boolean(payload.aiAvailable));
      }
      setHydrated(true);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Could not load your data.');
    } finally {
      refreshLock.current = false;
      setLoading(false);
    }
  }, [preview, onSessionExpired]);
  useEffect(() => {
    void readState();
  }, [readState]);
  useEffect(() => {
    const id = 'workspace-load-error';
    if (!loadError) {
      notifications.close(id);
      return;
    }
    notifications.add({
      id,
      title: hydrated
        ? 'Your latest data could not be refreshed.'
        : 'Your saved data could not be loaded.',
      description: hydrated
        ? loadError
        : 'Changes are paused until your saved data is available. Please retry.',
      type: 'error',
      priority: 'high',
      timeout: 0,
      actionProps: {
        children: loading ? 'Retrying…' : 'Retry',
        disabled: busy || loading,
        onClick: () => void readState(),
      },
    });
  }, [loadError, hydrated, loading, busy, readState, notifications]);
  useEffect(() => {
    if (preview) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void readState();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [preview, readState]);
  const mutate = useCallback(
    async (mutation: Mutation, success?: string): Promise<boolean> => {
      if (!preview && !hydrated) {
        notify('Load your saved data before making changes. Use Retry to reconnect.', true);
        return false;
      }
      if (mutationLock.current) return false;
      mutationLock.current = true;
      setBusy(true);
      try {
        if (preview) setState(applyMutation(state, mutation));
        else {
          const response = await fetch('/api/mutate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mutation, requestId: newId() }),
          });
          const payload = (await response.json()) as ApiPayload;
          if (response.status === 401 && payload.code === 'SIGN_IN_REQUIRED') {
            onSessionExpired?.();
            return false;
          }
          if (!response.ok || !payload.state)
            throw new Error(
              typeof payload.error === 'string'
                ? payload.error
                : payload.error?.message || 'Your change could not be saved. Please try again.',
            );
          latestRevision.current = payload.revision ?? latestRevision.current;
          setRevision(latestRevision.current);
          setState(payload.state);
          setAiAvailable(Boolean(payload.aiAvailable));
          setHydrated(true);
          setLoadError(null);
        }
        if (success) notify(success);
        return true;
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not save your change.', true);
        return false;
      } finally {
        mutationLock.current = false;
        setBusy(false);
      }
    },
    [preview, notify, state, hydrated, onSessionExpired],
  );
  const copyText = async (text: string, success = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(text);
      notify(success);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.select();
      let copied = false;
      try {
        copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textArea.remove();
      }
      notify(
        copied
          ? success
          : 'Copy is unavailable in this browser. Please use the download or try another browser.',
        !copied,
      );
    }
  };
  const acceptAgentState = (payload: {
    state: AppState;
    revision: number;
    aiAvailable: boolean;
  }) => {
    latestRevision.current = payload.revision;
    setRevision(payload.revision);
    setState(payload.state);
    setAiAvailable(payload.aiAvailable);
  };
  const disabled = busy || loading || !hydrated;
  return {
    state,
    revision,
    busy,
    disabled,
    aiAvailable,
    notifications,
    notify,
    readState,
    mutate,
    acceptAgentState,
    copyText,
  };
}
