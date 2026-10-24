import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState } from '@packages/shared/types';
import { applyMutation } from '@packages/shared/domain';
import { createToastManager } from '@packages/ui';
import { useMutation } from '@tanstack/react-query';
import type { WorkspaceMutationInput } from '@packages/api/schemas';
import type { CornerAppProps, Mutate } from './types';
import { rpc, useWorkspace, writeWorkspace, sessionLifetime } from '../../rpc';
import { newId } from './utils';

export function useWorkspaceState({
  initialState,
  initialRevision = 0,
  preview,
}: Pick<CornerAppProps, 'initialState' | 'initialRevision' | 'preview'>) {
  const generation = useRef(sessionLifetime()).current;
  const [previewState, setPreviewState] = useState<AppState>(initialState);
  const workspace = useWorkspace(!preview);
  const saveMutation = useMutation({
    mutationFn: (input: WorkspaceMutationInput) =>
      writeWorkspace(() => rpc.workspace.mutate(input), generation),
    retry: false,
  });
  const state = preview ? previewState : workspace.data?.state ?? initialState;
  const revision = preview ? initialRevision : workspace.data?.revision ?? initialRevision;
  const [notifications] = useState(() => createToastManager());
  const [busy, setBusy] = useState(false);
  const loading = !preview && workspace.isFetching;
  const hydrated = preview || Boolean(workspace.data);
  const loadError = preview ? null : workspace.error?.message ?? null;
  const aiAvailable = !preview && Boolean(workspace.data?.aiAvailable);
  const mutationLock = useRef(false);
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
    if (!preview && !mutationLock.current) await workspace.refetch();
  }, [preview, workspace.refetch]);
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
  const mutate = useCallback<Mutate>(
    async (mutation, success): Promise<boolean> => {
      if (!preview && generation !== sessionLifetime()) return false;
      if (!preview && !hydrated) {
        notify('Load your saved data before making changes. Use Retry to reconnect.', true);
        return false;
      }
      if (mutationLock.current) return false;
      mutationLock.current = true;
      setBusy(true);
      try {
        if (preview) setPreviewState(applyMutation(state, mutation));
        else await saveMutation.mutateAsync({ mutation, requestId: newId() });
        if (!preview && generation !== sessionLifetime()) return false;
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
    [preview, notify, state, hydrated, generation, saveMutation.mutateAsync],
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
    copyText,
  };
}
