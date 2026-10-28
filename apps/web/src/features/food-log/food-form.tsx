import { useState } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import type { FoodEntry, MealSlot } from '@packages/nutrition/types';
import { SLOTS } from '@packages/nutrition/types';
import { Loader2, Check } from 'lucide-react';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
} from '@packages/ui';
import { newId, zero, cap } from '../workspace/utils';
import { Dialog, Field, MacroFields, MacroLine } from '../workspace/workspace-ui';

export default function FoodForm({
  food,
  date,
  busy,
  onClose,
  onSave,
}: {
  food?: FoodEntry;
  date: string;
  busy: boolean;
  onClose: () => void;
  onSave: (food: FoodEntry) => Promise<void>;
}) {
  const [entryId] = useState(() => food?.id || newId());
  const [createdAt] = useState(() => food?.createdAt || new Date().toISOString());
  const [defaultValues] = useState(() => ({
    name: food?.name || '',
    nutrition: food?.nutrition || { ...zero },
    servings: food?.servings || 1,
    date: food?.date || date,
    slot: food?.slot || ('snack' as MealSlot),
  }));
  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }): string | undefined =>
        value.name.trim() ? undefined : 'Enter a food name.',
    },
    onSubmit: async ({ value }): Promise<void> => {
      if (busy || !value.name.trim()) return;
      try {
        await onSave({
          ...food,
          ...value,
          id: entryId,
          name: value.name.trim(),
          planEntryId: value.date === food?.date ? food?.planEntryId : undefined,
          createdAt,
        });
      } catch (failure) {
        form.setErrorMap({
          onSubmit:
            failure instanceof Error ? failure.message : 'Your food entry could not be saved.',
        });
      }
    },
  });
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const saveError = useStore(form.store, (state) => state.errorMap.onSubmit);
  return (
    <Dialog title={food ? 'Edit food entry' : 'Add to your food log'} onClose={onClose}>
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !form.state.isSubmitting) void form.handleSubmit();
        }}
      >
        <Field label="What did you eat?">
          <form.Field name="name">
            {(field) => (
              <Input
                autoComplete="off"
                required
                maxLength={180}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="e.g. Chicken sandwich"
              />
            )}
          </form.Field>
        </Field>
        <div className="form-three">
          <Field label="Date">
            <form.Field name="date">
              {(field) => (
                <Input
                  required
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              )}
            </form.Field>
          </Field>
          <Field label="Meal">
            <form.Field name="slot">
              {(field) => (
                <NativeSelect
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value as MealSlot)}
                >
                  {SLOTS.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {cap(s)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </form.Field>
          </Field>
          <Field label="Servings eaten">
            <form.Field name="servings">
              {(field) => (
                <Input
                  required
                  type="number"
                  min={0.25}
                  max={20}
                  step={0.25}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(Number(e.target.value))}
                />
              )}
            </form.Field>
          </Field>
        </div>
        <div className="form-section-label">NUTRITION PER SERVING</div>
        <form.Field name="nutrition">
          {(field) => (
            <MacroFields
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
            />
          )}
        </form.Field>
        <p className="form-help">
          Use the package label or your best estimate. Your log will multiply these values by the
          servings eaten.
        </p>
        <div className="food-total-preview">
          <span>This entry adds</span>
          <form.Subscribe
            selector={(state) => [state.values.nutrition, state.values.servings] as const}
          >
            {([nutrition, servings]) => <MacroLine nutrition={nutrition} servings={servings} />}
          </form.Subscribe>
        </div>
        {saveError && (
          <Alert variant="destructive">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}
        <div className="form-footer">
          <Button variant="outline" size="default" type="button" onClick={onClose}>
            Cancel
          </Button>
          <form.Subscribe selector={(state) => state.values.name}>
            {(name) => (
              <Button
                variant="default"
                size="default"
                disabled={busy || isSubmitting || !name.trim()}
                type="submit"
              >
                {busy || isSubmitting ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                Save food entry
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </Dialog>
  );
}
