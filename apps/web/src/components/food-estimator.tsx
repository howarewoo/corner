"use client";

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { FOOD_DESCRIPTION_MAX_LENGTH, FoodDescriptionSchema, FoodEstimateResultSchema, type EstimatedFood, type FoodEstimateResult } from '@corner/shared/food-estimate';

type EstimatePayload = {
  estimate?: unknown;
  code?: string;
  error?: string | { code?: string; message?: string };
};

type FoodEstimatorProps = {
  disabled: boolean;
  aiAvailable: boolean;
  onApply: (estimate: EstimatedFood) => void;
};

const formatAmount = (value: number, digits = 1) => value.toLocaleString(undefined, { maximumFractionDigits: digits });

export default function FoodEstimator({ disabled, aiAvailable, onApply }: FoodEstimatorProps) {
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
      const response = await fetch('/api/estimate-food', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intent),
        signal: controller.signal,
      });
      let payload: EstimatePayload;
      try {
        payload = await response.json() as EstimatePayload;
      } catch {
        throw new Error('The estimator returned an unreadable response. Try again to check the same request, or enter nutrition manually.');
      }
      if (sequence !== requestSequence.current || controller.signal.aborted) return;

      if (!response.ok) {
        const code = payload.code || (typeof payload.error === 'object' ? payload.error?.code : undefined);
        // Keep the same intent while the server is still processing it, or when
        // its allowance is temporarily unavailable. Transport failures also
        // retain the ID so a retry cannot accidentally purchase a second call.
        if (!code?.endsWith('_PENDING') && !code?.endsWith('_LIMIT') && code !== 'AI_BUSY') requestIntent.current = null;
        if (code === 'AI_NOT_CONFIGURED') {
          setConnectionUnavailable(true);
          return;
        }
        throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || 'Could not estimate this food. Please try again.');
      }

      const parsed = FoodEstimateResultSchema.safeParse(payload.estimate);
      if (!parsed.success) {
        requestIntent.current = null;
        throw new Error('This estimate could not be checked. Please try a more specific description.');
      }
      requestIntent.current = null;
      setResult(parsed.data);
    } catch (failure) {
      if (sequence !== requestSequence.current || (controller.signal.aborted && !timedOut)) return;
      setError(timedOut
        ? 'The estimate is taking too long. Try again to check the same request, or enter nutrition manually.'
        : failure instanceof TypeError
          ? 'Could not connect to the estimator. Try again to check the same request, or enter nutrition manually.'
          : failure instanceof Error ? failure.message : 'Could not estimate this food. Please try again.');
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

  return <section className="food-estimator" aria-label="Estimate nutrition from a food description">
    <label className="field" htmlFor={fieldId}>
      <span>Food and portions</span>
      <textarea
        id={fieldId}
        rows={4}
        maxLength={FOOD_DESCRIPTION_MAX_LENGTH}
        value={description}
        onChange={event => updateDescription(event.target.value)}
        disabled={disabled}
        aria-describedby={`${helpId}${connectionMissing ? ` ${connectionId}` : ''}`}
        placeholder="e.g. 2 large eggs scrambled in 1 tsp olive oil, with 2 slices of whole-wheat toast"
      />
      <small id={helpId}>Describe the entire amount you ate. Include quantities, preparation, oils or sauces, and the brand when it matters.</small>
    </label>

    {connectionMissing && <p className="food-estimator-connection" id={connectionId} role="status">AI estimates need an AI connection. You can still enter nutrition manually.</p>}

    <div className="food-estimator-actions">
      <button type="button" className="button primary" disabled={disabled || connectionMissing || pending || !descriptionValid} aria-busy={pending} onClick={() => void estimateFood()}>
        {pending ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
        {pending ? 'Estimating…' : 'Estimate nutrition'}
      </button>
      <p>You’ll review the estimate before adding it to your log.</p>
    </div>

    {error && <p className="form-error" role="alert">{error}</p>}

    <div className="food-estimator-feedback" aria-live="polite" aria-atomic="false">
      {pending && <p className="food-estimator-progress">Checking the food and portion details…</p>}
      {result?.status === 'needs_details' && <section className="food-estimator-clarification">
        <h3>A little more detail</h3>
        <p>Add these details to your description, then estimate again.</p>
        <ul>{result.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
      </section>}
      {result?.status === 'estimated' && <section className="food-estimator-result">
        <p className="food-estimator-caption">Approximate nutrition</p>
        <h3>{result.name}</h3>
        <p className="food-estimator-amount">{result.amountSummary}</p>
        <dl className="food-estimator-macros">
          <div><dt>Calories</dt><dd>{formatAmount(result.nutrition.calories, 0)}<span>kcal</span></dd></div>
          <div><dt>Protein</dt><dd>{formatAmount(result.nutrition.protein)}<span>g</span></dd></div>
          <div><dt>Carbs</dt><dd>{formatAmount(result.nutrition.carbs)}<span>g</span></dd></div>
          <div><dt>Fat</dt><dd>{formatAmount(result.nutrition.fat)}<span>g</span></dd></div>
        </dl>
        {result.assumptions.length > 0 && <div className="food-estimator-assumptions"><h4>Assumptions</h4><ul>{result.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></div>}
        <div className="food-estimator-result-footer">
          <p>These totals cover the whole amount described. You can adjust them before saving.</p>
          <button type="button" className={`button ${applied ? 'logged-button' : 'primary'}`} disabled={disabled || pending || applied} onClick={applyEstimate}><Check size={16} />{applied ? 'Estimate applied' : 'Use estimate'}</button>
        </div>
        {applied && <p className="food-estimator-applied">Estimate applied. Review the nutrition fields before saving your food entry.</p>}
      </section>}
    </div>
  </section>;
}
