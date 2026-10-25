// @vitest-environment jsdom
import { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, useMutation } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { createInitialState } from '@packages/workspace/initial-state';
import type { StateResponse } from '@packages/workspace/types';
import * as runtime from '../rpc';
import { json, mockHttp } from './http';

const snapshot = (revision: number): StateResponse => ({
  revision,
  state: createInitialState(),
  aiAvailable: false,
});

test('workspace rendering never rolls back and a new session rejects the old session write', async () => {
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  mockHttp(() => (requests++ === 0 ? response.promise : json({ json: snapshot(2) })));
  const oldWrite = Promise.withResolvers<StateResponse>();
  const completedWrite = Promise.withResolvers<StateResponse>();
  let writeAttempts = 0;
  let pendingWrite!: Promise<StateResponse>;
  function Consumer() {
    runtime.useSessionLifetime();
    const generation = useRef(runtime.sessionLifetime()).current;
    const workspace = runtime.useWorkspace();
    const write = useMutation({
      mutationFn: () =>
        runtime.writeWorkspace(
          () => (writeAttempts++ === 0 ? completedWrite : oldWrite).promise,
          generation,
        ),
      retry: false,
    });
    return (
      <section>
        <output aria-label="Workspace revision">{workspace.data?.revision ?? 'loading'}</output>
        <button
          disabled={write.isPending}
          onClick={() => {
            pendingWrite = write.mutateAsync();
            void pendingWrite.catch(() => {});
          }}
        >
          Save
        </button>
      </section>
    );
  }
  render(
    <QueryClientProvider client={runtime.queryClient}>
      <Consumer />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(requests).toBe(1));
  await act(async () => {
    runtime.acceptWorkspace(snapshot(9));
    response.resolve(json({ json: snapshot(8) }));
    await runtime.queryClient.getQueryCache().find({ queryKey: runtime.privateKey('workspace') })
      ?.promise;
  });
  await waitFor(() => expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('9'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await act(async () => {
    completedWrite.resolve(snapshot(10));
    await pendingWrite;
  });
  await waitFor(() => expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('10'));
  const query = runtime.queryClient
    .getQueryCache()
    .find<StateResponse>({ queryKey: runtime.privateKey('workspace') })!;
  const readWorkspace = query.options.queryFn;
  if (typeof readWorkspace !== 'function')
    throw new Error('Workspace consumer must supply its production query.');
  await act(async () => {
    await query.fetch({
      ...query.options,
      queryFn: async (context) => {
        const read = await readWorkspace(context);
        // A mutation wins between transport resolution and Query ingesting the older read.
        runtime.acceptWorkspace(snapshot(11));
        return read;
      },
    });
  });
  await waitFor(() => expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('11'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  const rejectedWrite = expect(pendingWrite).rejects.toThrow('session has ended');
  await act(async () => {
    runtime.clearPrivateState();
    runtime.acceptWorkspace(snapshot(2));
    oldWrite.resolve(snapshot(20));
    await rejectedWrite;
  });
  expect(screen.getByLabelText('Workspace revision')).toHaveTextContent('2');
  expect(runtime.queryClient.getMutationCache().getAll()).toEqual([]);
});
