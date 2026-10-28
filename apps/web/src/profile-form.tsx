import { useState, type ReactNode } from 'react';
import { useForm, useStore } from '@tanstack/react-form';
import { Check, Loader2, SlidersHorizontal } from 'lucide-react';
import type { Macros } from '@packages/nutrition/types';
import type { Settings } from '@packages/workspace/types';
import { SettingsSchema } from '@packages/workspace/mutations';
import { DEFAULT_PROFILE } from '@packages/workspace/initial-state';
import {
  Button,
  Input,
  Textarea,
  Checkbox,
  NativeSelect,
  NativeSelectOption,
  Field,
  FieldLabel,
  FieldDescription,
  Alert,
  Label,
} from '@packages/ui';

const metrics: Array<{ key: keyof Macros; label: string; max: number }> = [
  { key: 'calories', label: 'Calories · kcal', max: 10000 },
  { key: 'protein', label: 'Protein · g', max: 1500 },
  { key: 'carbs', label: 'Carbs · g', max: 2500 },
  { key: 'fat', label: 'Fat · g', max: 1500 },
];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function renderField(label: string, id: string, children: ReactNode, hint?: string) {
  return (
    <Field className="field">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription>{hint}</FieldDescription>}
    </Field>
  );
}

export default function ProfileForm({
  settings,
  busy,
  onSave,
}: {
  settings: Settings;
  busy: boolean;
  onSave: (settings: Settings) => Promise<boolean | void>;
}) {
  const [defaultValues] = useState(() => ({
    ...structuredClone(settings),
    profile: { ...DEFAULT_PROFILE, ...settings.profile },
    targetsSet:
      settings.setup?.nutritionTargetsSet ??
      (settings.training.calories > 0 && settings.rest.calories > 0),
  }));
  const form = useForm({
    defaultValues,
    validators: {
      onSubmit: ({ value }) => {
        if (value.targetsSet && (value.training.calories <= 0 || value.rest.calories <= 0))
          return 'Enter calories for both training and recovery days, or leave nutrition targets unset for now.';
        const { targetsSet, ...draft } = value;
        const parsed = SettingsSchema.safeParse({
          ...draft,
          setup: {
            completedAt: draft.setup?.completedAt || new Date().toISOString(),
            nutritionTargetsSet: targetsSet,
          },
        });
        return parsed.success
          ? undefined
          : parsed.error.issues[0]?.message || 'Check the highlighted values.';
      },
    },
    onSubmit: async ({ value }): Promise<void> => {
      if (busy) return;
      const { targetsSet, ...draft } = value;
      const next = SettingsSchema.parse({
        ...draft,
        setup: {
          completedAt: draft.setup?.completedAt || new Date().toISOString(),
          nutritionTargetsSet: targetsSet,
        },
      });
      try {
        await onSave(next);
      } catch (failure) {
        form.setErrorMap({
          onSubmit: failure instanceof Error ? failure.message : 'Your profile could not be saved.',
        });
      }
    },
  });
  const timezone = useStore(form.store, (state) => state.values.timezone);
  const targetsSet = useStore(form.store, (state) => state.values.targetsSet);
  const error = useStore(form.store, (state) => state.errorMap.onSubmit);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  const zones = [
    ...new Set([
      timezone,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Toronto',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Singapore',
      'Asia/Tokyo',
      'Australia/Sydney',
    ]),
  ];

  return (
    <form
      className="standalone-profile corner-ui"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !form.state.isSubmitting) void form.handleSubmit();
      }}
    >
      <section className="profile-section">
        <div className="section-heading">
          <h2>Your profile</h2>
          <SlidersHorizontal size={18} />
        </div>
        <p className="profile-help">
          Your plans use the details you enter here. You can update them at any time.
        </p>
        <div className="form-two">
          {renderField(
            'Preferred name',
            'profile-name',
            <form.Field name="name">
              {(field) => (
                <Input
                  id="profile-name"
                  value={field.state.value}
                  maxLength={80}
                  required
                  autoComplete="given-name"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              )}
            </form.Field>,
          )}
          {renderField(
            'Time zone',
            'profile-timezone',
            <form.Field name="timezone">
              {(field) => (
                <NativeSelect
                  id="profile-timezone"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  {zones.map((zone) => (
                    <NativeSelectOption key={zone} value={zone}>
                      {zone.replaceAll('_', ' ')}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
            </form.Field>,
          )}
        </div>
        {renderField(
          'What are you working toward?',
          'profile-goals',
          <form.Field name="profile.goals">
            {(field) => (
              <Textarea
                id="profile-goals"
                rows={2}
                maxLength={2000}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Your goals, priorities, or what you want to feel better at"
              />
            )}
          </form.Field>,
          'Optional. Use your own words.',
        )}
        <div className="form-three">
          {renderField(
            'Training experience',
            'profile-experience',
            <form.Field name="profile.experience">
              {(field) => (
                <NativeSelect
                  id="profile-experience"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <NativeSelectOption value="">Not specified</NativeSelectOption>
                  {[
                    'Getting started',
                    'Returning to training',
                    'Training regularly',
                    'Experienced',
                  ].map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {value}
                    </NativeSelectOption>
                  ))}
                  {field.state.value &&
                    ![
                      'Getting started',
                      'Returning to training',
                      'Training regularly',
                      'Experienced',
                    ].includes(field.state.value) && (
                      <NativeSelectOption value={field.state.value}>
                        {field.state.value}
                      </NativeSelectOption>
                    )}
                </NativeSelect>
              )}
            </form.Field>,
          )}
          {renderField(
            'Typical session · min',
            'profile-session-minutes',
            <form.Field name="profile.sessionMinutes">
              {(field) => (
                <Input
                  id="profile-session-minutes"
                  type="number"
                  min={5}
                  max={600}
                  step={5}
                  required
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(Number(event.target.value))}
                />
              )}
            </form.Field>,
          )}
          {renderField(
            'Workout weights',
            'profile-workout-unit',
            <form.Field name="profile.defaultWorkoutUnit">
              {(field) => (
                <NativeSelect
                  id="profile-workout-unit"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value as 'lb' | 'kg')}
                >
                  <NativeSelectOption value="lb">Pounds · lb</NativeSelectOption>
                  <NativeSelectOption value="kg">Kilograms · kg</NativeSelectOption>
                </NativeSelect>
              )}
            </form.Field>,
          )}
        </div>
        {renderField(
          'Equipment available',
          'profile-equipment',
          <form.Field name="profile.equipment">
            {(field) => (
              <Textarea
                id="profile-equipment"
                rows={2}
                maxLength={2000}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Gym access, home equipment, or activities you enjoy"
              />
            )}
          </form.Field>,
        )}
        {renderField(
          'Constraints and preferences',
          'profile-constraints',
          <form.Field name="profile.constraints">
            {(field) => (
              <Textarea
                id="profile-constraints"
                rows={2}
                maxLength={3000}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Time limits, movements to avoid, scheduling needs, or preferences"
              />
            )}
          </form.Field>,
        )}
      </section>
      <section className="profile-section">
        <h2>Food preferences</h2>
        {renderField(
          'Dietary needs and preferences',
          'profile-dietary-preferences',
          <form.Field name="profile.dietaryPreferences">
            {(field) => (
              <Textarea
                id="profile-dietary-preferences"
                rows={2}
                maxLength={2000}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Allergies, foods you avoid, and foods you enjoy"
              />
            )}
          </form.Field>,
        )}
        {renderField(
          'Groceries and meal prep',
          'profile-grocery-preferences',
          <form.Field name="profile.groceryPreferences">
            {(field) => (
              <Textarea
                id="profile-grocery-preferences"
                rows={2}
                maxLength={1000}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Where you shop, your budget, cooking time, and how often you prep"
              />
            )}
          </form.Field>,
        )}
      </section>
      <section className="profile-section">
        <h2>Nutrition targets</h2>
        <Label htmlFor="profile-targets-set" className="standalone-checkbox cursor-pointer">
          <form.Field name="targetsSet">
            {(field) => (
              <Checkbox
                id="profile-targets-set"
                checked={field.state.value}
                onBlur={field.handleBlur}
                onCheckedChange={(checked) => field.handleChange(Boolean(checked))}
              />
            )}
          </form.Field>
          <span>I want to set my daily targets</span>
        </Label>
        <p className="profile-help">
          Enter targets you have chosen. You can track food and plan meals before setting targets.
        </p>
        {targetsSet && (
          <div className="profile-targets">
            {(['training', 'rest'] as const).map((kind) => (
              <div key={kind}>
                <h3>{kind === 'training' ? 'Training days' : 'Recovery days'}</h3>
                <div className="profile-macro-grid">
                  {metrics.map((metric) => (
                    <div key={metric.key}>
                      {renderField(
                        metric.label,
                        `macro-${kind}-${metric.key}`,
                        <form.Field name={`${kind}.${metric.key}`}>
                          {(field) => (
                            <Input
                              id={`macro-${kind}-${metric.key}`}
                              aria-label={`${kind === 'training' ? 'Training' : 'Recovery'} ${metric.label}`}
                              type="number"
                              min={0}
                              max={metric.max}
                              step="any"
                              required
                              value={field.state.value}
                              onBlur={field.handleBlur}
                              onChange={(event) => field.handleChange(Number(event.target.value))}
                            />
                          )}
                        </form.Field>,
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="profile-section">
        <h2>Your usual week</h2>
        <p className="profile-help">
          This helps select daily nutrition targets. Add specific workouts in your planner; nothing
          is logged automatically.
        </p>
        <div className="profile-week">
          {[1, 2, 3, 4, 5, 6, 0].map((day) => {
            return (
              <form.Field key={day} name={`schedule.${day}`}>
                {(field) => {
                  const activity = field.state.value || 'rest';
                  return (
                    <Field className="field">
                      <FieldLabel htmlFor={`schedule-day-${day}`}>{weekdays[day]}</FieldLabel>
                      <NativeSelect
                        id={`schedule-day-${day}`}
                        value={activity}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <NativeSelectOption value="rest">No regular session</NativeSelectOption>
                        <NativeSelectOption value="strength">Strength</NativeSelectOption>
                        <NativeSelectOption value="conditioning">Conditioning</NativeSelectOption>
                        <NativeSelectOption value="boxing">Boxing</NativeSelectOption>
                        {!['rest', 'strength', 'conditioning', 'boxing'].includes(activity) && (
                          <NativeSelectOption value={activity}>{activity}</NativeSelectOption>
                        )}
                      </NativeSelect>
                    </Field>
                  );
                }}
              </form.Field>
            );
          })}
        </div>
      </section>
      {error && (
        <Alert variant="destructive" className="form-error">
          {error}
        </Alert>
      )}
      <div className="profile-save">
        <Button variant="default" type="submit" disabled={busy || isSubmitting}>
          {busy || isSubmitting ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
          {busy || isSubmitting ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
