import { useEffect, useRef, useState } from 'react';
import type { FoodEntry, MealSlot, Macros } from '@packages/nutrition/types';
import { SLOTS } from '@packages/nutrition/types';
import { foodEstimateToDraft, type EstimatedFood } from '@packages/nutrition/food-estimate';
import { Sparkles, Pencil, CheckCircle2, Loader2, Check } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  ToggleGroup,
  ToggleGroupItem,
} from '@packages/ui';
import FoodEstimator from '../../components/food-estimator';
import { newId, zero, cap } from '../workspace/utils';
import { Dialog, Field, MacroFields, MacroLine } from '../workspace/workspace-ui';

export default function FoodForm({
  food,
  date,
  busy,
  aiAvailable,
  onClose,
  onSave,
}: {
  food?: FoodEntry;
  date: string;
  busy: boolean;
  aiAvailable: boolean;
  onClose: () => void;
  onSave: (food: FoodEntry) => void;
}) {
  const [entryId] = useState(() => food?.id || newId());
  const [createdAt] = useState(() => food?.createdAt || new Date().toISOString());
  const [name, setName] = useState(food?.name || '');
  const [nutrition, setNutrition] = useState<Macros>(food?.nutrition || { ...zero });
  const [servings, setServings] = useState(food?.servings || 1);
  const [foodDate, setFoodDate] = useState(food?.date || date);
  const [slot, setSlot] = useState<MealSlot>(food?.slot || 'snack');
  const [entryMode, setEntryMode] = useState<'describe' | 'manual'>(() =>
    food || !aiAvailable ? 'manual' : 'describe',
  );
  const [estimatedAmount, setEstimatedAmount] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const focusReview = useRef(false);
  useEffect(() => {
    if (entryMode === 'manual' && focusReview.current) {
      nameInput.current?.focus();
      focusReview.current = false;
    }
  }, [entryMode]);
  const useEstimate = (estimate: EstimatedFood) => {
    const draft = foodEstimateToDraft(estimate);
    setName(draft.name);
    setNutrition(draft.nutrition);
    setServings(draft.servings);
    setEstimatedAmount(estimate.amountSummary);
    focusReview.current = true;
    setEntryMode('manual');
  };
  return (
    <Dialog title={food ? 'Edit food entry' : 'Add to your food log'} onClose={onClose}>
      {!food && (
        <ToggleGroup
          aria-label="Food entry method"
          value={[entryMode]}
          onValueChange={(values) => {
            if (values[0]) setEntryMode(values[0] as 'describe' | 'manual');
          }}
        >
          <ToggleGroupItem value="describe">
            <Sparkles size={16} />
            Describe food
          </ToggleGroupItem>
          <ToggleGroupItem value="manual">
            <Pencil size={16} />
            Enter manually
          </ToggleGroupItem>
        </ToggleGroup>
      )}
      {!food && (
        <div
          className="food-entry-mode-panel food-entry-description"
          hidden={entryMode !== 'describe'}
        >
          <FoodEstimator
            disabled={busy || entryMode !== 'describe'}
            aiAvailable={aiAvailable}
            onApply={useEstimate}
          />
        </div>
      )}
      <div className="food-entry-mode-panel" hidden={entryMode !== 'manual'}>
        <form
          className="dialog-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !name.trim()) return;
            onSave({
              ...food,
              id: entryId,
              date: foodDate,
              slot,
              name: name.trim(),
              nutrition,
              servings,
              planEntryId: foodDate === food?.date ? food?.planEntryId : undefined,
              createdAt,
            });
          }}
        >
          {estimatedAmount && (
            <Alert variant="success" role="status">
              <CheckCircle2 size={17} />
              <AlertDescription>
                Estimate applied for <b>{estimatedAmount}</b>. Review or edit the values before
                saving.
              </AlertDescription>
            </Alert>
          )}
          <Field label="What did you eat?">
            <Input
              ref={nameInput}
              autoComplete="off"
              required
              maxLength={180}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Chicken sandwich"
            />
          </Field>
          <div className="form-three">
            <Field label="Date">
              <Input
                required
                type="date"
                value={foodDate}
                onChange={(e) => setFoodDate(e.target.value)}
              />
            </Field>
            <Field label="Meal">
              <NativeSelect value={slot} onChange={(e) => setSlot(e.target.value as MealSlot)}>
                {SLOTS.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {cap(s)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field
              label={estimatedAmount ? 'Portions eaten' : 'Servings eaten'}
              hint={estimatedAmount ? '1 = the full described amount' : undefined}
            >
              <Input
                required
                type="number"
                min={0.25}
                max={20}
                step={0.25}
                value={servings}
                onChange={(e) => setServings(Number(e.target.value))}
              />
            </Field>
          </div>
          <div className="form-section-label">
            {estimatedAmount ? 'NUTRITION FOR THE DESCRIBED AMOUNT' : 'NUTRITION PER SERVING'}
          </div>
          <MacroFields value={nutrition} onChange={setNutrition} />
          <p className="form-help">
            {estimatedAmount
              ? 'This estimate covers the entire amount you described. Keep portions at 1 to log that amount, or change it to scale the entry. Check package labels when available.'
              : 'Use the package label or your best estimate. Your log will multiply these values by the servings eaten.'}
          </p>
          <div className="food-total-preview">
            <span>This entry adds</span>
            <MacroLine nutrition={nutrition} servings={servings} />
          </div>
          <div className="form-footer">
            <Button variant="outline" size="default" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="default" size="default" disabled={busy || !name.trim()} type="submit">
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Save food entry
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
