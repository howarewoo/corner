import { useEffect, useRef, useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { useMutation } from '@tanstack/react-query';
import { ArrowUpFromLine, Loader2 } from 'lucide-react';
import { Alert, Button, Field, FieldLabel, Input } from '@packages/ui';
import { errorMessage } from './api';
import { rpc, scoped, writeWorkspace, sessionLifetime } from './rpc';
import { MAX_WORKSPACE_TRANSFER_BYTES } from '@packages/api/workspace-data';

export default function ImportWorkspace({
  onImported,
  disabled,
}: {
  onImported: () => void;
  disabled: boolean;
}) {
  const generation = useRef(sessionLifetime()).current;
  const previewMutation = useMutation({
    mutationFn: (input: Parameters<typeof rpc.workspace.previewImport>[0]) =>
      scoped(() => rpc.workspace.previewImport(input), generation),
    retry: false,
  });
  const importMutation = useMutation({
    mutationFn: (input: Parameters<typeof rpc.workspace.import>[0]) =>
      writeWorkspace(() => rpc.workspace.import(input), generation),
    retry: false,
  });
  const [candidate, setCandidate] = useState<unknown>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selection = useRef(0);
  const intent = useRef<string | null>(null);
  const importRevision = useRef(0);
  const committing = useRef(false);
  const form = useForm({
    defaultValues: { confirmation: '' },
    validators: {
      onChange: ({ value }) =>
        value.confirmation.trim() === 'IMPORT' ? undefined : 'Type IMPORT to confirm',
    },
    onSubmitMeta: { selection: 0 },
    onSubmit: async ({ meta }) => {
      if (meta.selection !== selection.current) return;
      await commit();
    },
  });
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const canConfirm = useStore(form.store, (state) => state.values.confirmation.trim() === 'IMPORT');
  useEffect(
    () => () => {
      selection.current += 1;
    },
    [],
  );
  async function inspect(file?: File) {
    const sequence = ++selection.current;
    setCandidate(null);
    setSummary(null);
    form.reset();
    setError('');
    intent.current = null;
    if (!file) return;
    setBusy(true);
    setFileName(file.name);
    try {
      if (file.size > MAX_WORKSPACE_TRANSFER_BYTES)
        throw new Error('Choose a Corner JSON export no larger than 32 MiB.');
      const parsed = JSON.parse(await file.text());
      const state = parsed?.state ?? parsed;
      if (selection.current !== sequence || generation !== sessionLifetime()) return;
      const result = await previewMutation.mutateAsync({ state });
      if (selection.current !== sequence || generation !== sessionLifetime()) return;
      if (!result.canImport)
        throw new Error(
          'This account already has saved records. Import is available only in an empty workspace.',
        );
      importRevision.current = result.revision;
      setCandidate(state);
      setSummary(result.summary);
      intent.current = crypto.randomUUID();
    } catch (failure) {
      if (selection.current === sequence)
        setError(
          failure instanceof SyntaxError
            ? 'This file is not valid JSON. Choose the export downloaded from Corner.'
            : errorMessage(failure),
        );
    } finally {
      if (selection.current === sequence) setBusy(false);
    }
  }
  async function commit() {
    if (generation !== sessionLifetime()) return;
    if (
      disabled ||
      busy ||
      committing.current ||
      !candidate ||
      !summary ||
      form.state.values.confirmation.trim() !== 'IMPORT'
    )
      return;
    committing.current = true;
    const current = selection.current;
    setBusy(true);
    setError('');
    try {
      const requestId = intent.current!;
      await importMutation.mutateAsync({
        state: candidate,
        requestId,
        expectedRevision: importRevision.current,
      });
      if (current === selection.current && generation === sessionLifetime()) {
        onImported();
        setCandidate(null);
        setSummary(null);
        form.reset();
      }
    } catch (failure) {
      if (current === selection.current) setError(errorMessage(failure));
    } finally {
      committing.current = false;
      if (current === selection.current) setBusy(false);
    }
  }
  const counts = summary
    ? Object.entries(summary)
        .filter(([, value]) => typeof value === 'number' && value >= 0)
        .filter(([key]) => key !== 'bytes')
    : [];
  return (
    <section className="import-workspace profile-section corner-ui">
      <h2>Import workspace</h2>
      <p className="profile-help">
        Import a Corner JSON export into an empty workspace to keep your recipes, plans, and
        history. Existing records are never overwritten.
      </p>
      <Field className="field">
        <FieldLabel htmlFor="import-file">Corner export · JSON</FieldLabel>
        <Input
          id="import-file"
          type="file"
          accept=".json,application/json"
          disabled={disabled || busy || submitting}
          onChange={(event) => void inspect(event.target.files?.[0])}
        />
      </Field>
      {busy && !summary && (
        <p className="standalone-status" role="status">
          <Loader2 size={17} className="spin" />
          Checking the export…
        </p>
      )}
      {summary && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!committing.current) void form.handleSubmit({ selection: selection.current });
          }}
        >
          <div className="import-summary">
            <h3>Review your import</h3>
            <p>{fileName}</p>
            {counts.length > 0 && (
              <dl>
                {counts.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}</dt>
                    <dd>{String(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
            <p>
              The import copies records into this account. It does not change your original
              workspace.
            </p>
          </div>
          <form.Field name="confirmation">
            {(field) => (
              <Field className="field">
                <FieldLabel htmlFor="import-confirmation">Type IMPORT to confirm</FieldLabel>
                <Input
                  id="import-confirmation"
                  autoComplete="off"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  disabled={disabled || busy || submitting}
                />
              </Field>
            )}
          </form.Field>
          <Button
            variant="default"
            size="default"
            type="submit"
            disabled={disabled || busy || submitting || !canConfirm}
          >
            {busy ? <Loader2 className="spin" size={16} /> : <ArrowUpFromLine size={16} />}
            {busy ? 'Importing…' : 'Import my records'}
          </Button>
        </form>
      )}
      {error && (
        <Alert variant="destructive" className="form-error">
          {error}
        </Alert>
      )}
    </section>
  );
}
