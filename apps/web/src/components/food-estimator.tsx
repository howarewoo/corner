'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { rpc, scoped, errorCode, sessionLifetime } from '../rpc';
import { Check, Loader2, Sparkles } from 'lucide-react';
import {
  FOOD_DESCRIPTION_MAX_LENGTH,
  FoodDescriptionSchema,
  type EstimatedFood,
  type FoodEstimateResult,
} from '@packages/nutrition/food-estimate';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Textarea,
} from '@packages/ui';

type FoodEstimatorProps = {
  disabled: boolean;
  aiAvailable: boolean;
  onApply: (estimate: EstimatedFood) => void;
};

const formatAmount = (value: number, digits = 1) =>
  value.toLocaleString(undefined, { maximumFractionDigits: digits });

export default function FoodEstimator({ disabled, aiAvailable, onApply }: FoodEstimatorProps) {
  const generation = useRef(sessionLifetime()).current;
  const estimateMutation = useMutation({
    mutationFn: ({ input, signal }: {
      input: Parameters<typeof rpc.ai.estimateFood>[0];
      signal: AbortSignal;
    }) => scoped(() => rpc.ai.estimateFood(input, { signal }), generation),
    retry: false,
  });
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const connectionId = `${fieldId}-connection`;
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<FoodEstimateResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const requestSequence = useRef(0);
  const currentRequest = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const requestIntent = useRef<{ description: string; requestId: string } | null>(null);
  const connectionMissing = !aiAvailable || connectionUnavailable;
  const descriptionValid = FoodDescriptionSchema.safeParse(description).success;

  const cancelRequest = useCallback(() => {
    requestSequence.current += 1;
    currentRequest.current?.abort();
    currentRequest.current = null;
    inFlight.current = false;
  }, []);

  useEffect(() => cancelRequest, [cancelRequest]);
  useEffect(() => {
    if (disabled || !aiAvailable) {
      cancelRequest();
      setPending(false);
    }
  }, [disabled, aiAvailable, cancelRequest]);
  useEffect(() => {
    if (aiAvailable) setConnectionUnavailable(false);
  }, [aiAvailable]);

  function updateDescription(value: string) {
    cancelRequest();
    requestIntent.current = null;
    setDescription(value);
    setPending(false);
    setResult(null);
    setApplied(false);
    setError(null);
  }

  async function estimateFood() {
    if (generation !== sessionLifetime()) return;
    const input = description.trim();
    if (disabled || connectionMissing || inFlight.current || !descriptionValid) return;

    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    currentRequest.current = controller;
    inFlight.current = true;
    if (requestIntent.current?.description !== input) {
      requestIntent.current = { description: input, requestId: crypto.randomUUID() };
    }
    const intent = requestIntent.current;
    setPending(true);
    setResult(null);
    setError(null);
    setApplied(false);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);

    try {
      const payload = await estimateMutation.mutateAsync({ input: intent, signal: controller.signal });
      if (generation !== sessionLifetime() || sequence !== requestSequence.current || controller.signal.aborted) return;
      requestIntent.current = null;
      setResult(payload.estimate);
    } catch (failure) {
      if (sequence !== requestSequence.current || (controller.signal.aborted && !timedOut)) return;
      const code = errorCode(failure);
      if (code && !code.endsWith('_PENDING') && !code.endsWith('_LIMIT') && code !== 'AI_BUSY')
        requestIntent.current = null;
      if (code === 'AI_NOT_CONFIGURED') {
        setConnectionUnavailable(true);
        return;
      }
      setError(
        timedOut
          ? 'The estimate is taking too long. Try again to check the same request, or enter nutrition manually.'
          : failure instanceof TypeError
            ? 'Could not connect to the estimator. Try again to check the same request, or enter nutrition manually.'
            : failure instanceof Error
              ? failure.message
              : 'Could not estimate this food. Please try again.',
      );
    } finally {
      clearTimeout(timeout);
      if (sequence === requestSequence.current) {
        currentRequest.current = null;
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  function applyEstimate() {
    if (disabled || pending || applied || result?.status !== 'estimated') return;
    setApplied(true);
    onApply(result);
  }

  return (
    <section
      className="food-estimator corner-ui"
      aria-label="Estimate nutrition from a food description"
    >
      <Field className="field">
        <FieldLabel htmlFor={fieldId}>Food and portions</FieldLabel>
        <Textarea
          id={fieldId}
          name="foodDescription"
          rows={4}
          maxLength={FOOD_DESCRIPTION_MAX_LENGTH}
          value={description}
          onChange={(event) => updateDescription(event.target.value)}
          disabled={disabled}
          aria-describedby={`${helpId}${connectionMissing ? ` ${connectionId}` : ''}`}
          placeholder="e.g. 2 large eggs scrambled in 1 tsp olive oil, with 2 slices of whole-wheat toast"
        />
        <FieldDescription id={helpId}>
          Describe the entire amount you ate. Include quantities, preparation, oils or sauces, and
          the brand when it matters.
        </FieldDescription>
      </Field>

      {connectionMissing && (
        <Alert variant="warning" className="food-estimator-connection" id={connectionId}>
          <AlertDescription>
            AI estimates need an AI connection. You can still enter nutrition manually.
          </AlertDescription>
        </Alert>
      )}

      <div className="food-estimator-actions">
        <Button
          type="button"
          variant="default"
          disabled={disabled || connectionMissing || pending || !descriptionValid}
          aria-busy={pending}
          onClick={() => void estimateFood()}
        >
          {pending ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
          {pending ? 'Estimating…' : 'Estimate nutrition'}
        </Button>
        <p>You’ll review the estimate before adding it to your log.</p>
      </div>

      {error && (
        <Alert variant="destructive" className="form-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="food-estimator-feedback" aria-live="polite" aria-atomic="false">
        {pending && (
          <p className="food-estimator-progress">Checking the food and portion details…</p>
        )}
        {result?.status === 'needs_details' && (
          <section className="food-estimator-clarification">
            <h3>A little more detail</h3>
            <p>Add these details to your description, then estimate again.</p>
            <ul>
              {result.questions.map((question, index) => (
                <li key={index}>{question}</li>
              ))}
            </ul>
          </section>
        )}
        {result?.status === 'estimated' && (
          <section className="food-estimator-result">
            <Badge variant="outline" className="food-estimator-caption">
              Approximate nutrition
            </Badge>
            <h3>{result.name}</h3>
            <p className="food-estimator-amount">{result.amountSummary}</p>
            <dl className="food-estimator-macros">
              <div>
                <dt>Calories</dt>
                <dd>
                  {formatAmount(result.nutrition.calories, 0)}
                  <span>kcal</span>
                </dd>
              </div>
              <div>
                <dt>Protein</dt>
                <dd>
                  {formatAmount(result.nutrition.protein)}
                  <span>g</span>
                </dd>
              </div>
              <div>
                <dt>Carbs</dt>
                <dd>
                  {formatAmount(result.nutrition.carbs)}
                  <span>g</span>
                </dd>
              </div>
              <div>
                <dt>Fat</dt>
                <dd>
                  {formatAmount(result.nutrition.fat)}
                  <span>g</span>
                </dd>
              </div>
            </dl>
            {result.assumptions.length > 0 && (
              <div className="food-estimator-assumptions">
                <h4>Assumptions</h4>
                <ul>
                  {result.assumptions.map((assumption, index) => (
                    <li key={index}>{assumption}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="food-estimator-result-footer">
              <p>
                These totals cover the whole amount described. You can adjust them before saving.
              </p>
              <Button
                type="button"
                variant={applied ? 'secondary' : 'default'}
                disabled={disabled || pending || applied}
                onClick={applyEstimate}
              >
                <Check size={16} />
                {applied ? 'Estimate applied' : 'Use estimate'}
              </Button>
            </div>
            {applied && (
              <Alert variant="success" className="food-estimator-applied">
                <AlertDescription>
                  Estimate applied. Review the nutrition fields before saving your food entry.
                </AlertDescription>
              </Alert>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
