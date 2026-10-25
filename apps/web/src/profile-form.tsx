import { useState, type FormEvent, type ReactNode } from 'react';
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
  const [draft, setDraft] = useState<Settings>(() => ({
    ...structuredClone(settings),
    profile: { ...DEFAULT_PROFILE, ...settings.profile },
  }));
  const [targetsSet, setTargetsSet] = useState(
    settings.setup?.nutritionTargetsSet ??
      (settings.training.calories > 0 && settings.rest.calories > 0),
  );
  const [error, setError] = useState('');
  const profile = draft.profile!;
  const updateProfile = (values: Partial<NonNullable<Settings['profile']>>) =>
    setDraft((current) => ({ ...current, profile: { ...current.profile!, ...values } }));
  const zones = [
    ...new Set([
      draft.timezone,
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (targetsSet && (draft.training.calories <= 0 || draft.rest.calories <= 0)) {
      setError(
        'Enter calories for both training and recovery days, or leave nutrition targets unset for now.',
      );
      return;
    }
    const next = {
      ...draft,
      setup: {
        completedAt: draft.setup?.completedAt || new Date().toISOString(),
        nutritionTargetsSet: targetsSet,
      },
    };
    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || 'Check the highlighted values.');
      return;
    }
    try {
      await onSave(parsed.data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Your profile could not be saved.');
    }
  }

  return (
    <form className="standalone-profile corner-ui" onSubmit={submit}>
      <section className="profile-section">
        <div className="section-heading">
          <h2>Your profile</h2>
          <SlidersHorizontal size={18} />
        </div>
        <p className="profile-help">
          Your plans and agent use the details you enter here. You can update them at any time.
        </p>
        <div className="form-two">
          {renderField(
            'Preferred name',
            'profile-name',
            <Input
              id="profile-name"
              value={draft.name}
              maxLength={80}
              required
              autoComplete="given-name"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />,
          )}
          {renderField(
            'Time zone',
            'profile-timezone',
            <NativeSelect
              id="profile-timezone"
              value={draft.timezone}
              onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
            >
              {zones.map((zone) => (
                <NativeSelectOption key={zone} value={zone}>
                  {zone.replaceAll('_', ' ')}
                </NativeSelectOption>
              ))}
            </NativeSelect>,
          )}
        </div>
        {renderField(
          'What are you working toward?',
          'profile-goals',
          <Textarea
            id="profile-goals"
            rows={2}
            maxLength={2000}
            value={profile.goals}
            onChange={(event) => updateProfile({ goals: event.target.value })}
            placeholder="Your goals, priorities, or what you want to feel better at"
          />,
          'Optional. Use your own words.',
        )}
        <div className="form-three">
          {renderField(
            'Training experience',
            'profile-experience',
            <NativeSelect
              id="profile-experience"
              value={profile.experience}
              onChange={(event) => updateProfile({ experience: event.target.value })}
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
              {profile.experience &&
                ![
                  'Getting started',
                  'Returning to training',
                  'Training regularly',
                  'Experienced',
                ].includes(profile.experience) && (
                  <NativeSelectOption value={profile.experience}>
                    {profile.experience}
                  </NativeSelectOption>
                )}
            </NativeSelect>,
          )}
          {renderField(
            'Typical session · min',
            'profile-session-minutes',
            <Input
              id="profile-session-minutes"
              type="number"
              min={5}
              max={600}
              step={5}
              required
              value={profile.sessionMinutes}
              onChange={(event) => updateProfile({ sessionMinutes: Number(event.target.value) })}
            />,
          )}
          {renderField(
            'Workout weights',
            'profile-workout-unit',
            <NativeSelect
              id="profile-workout-unit"
              value={profile.defaultWorkoutUnit}
              onChange={(event) =>
                updateProfile({ defaultWorkoutUnit: event.target.value as 'lb' | 'kg' })
              }
            >
              <NativeSelectOption value="lb">Pounds · lb</NativeSelectOption>
              <NativeSelectOption value="kg">Kilograms · kg</NativeSelectOption>
            </NativeSelect>,
          )}
        </div>
        {renderField(
          'Equipment available',
          'profile-equipment',
          <Textarea
            id="profile-equipment"
            rows={2}
            maxLength={2000}
            value={profile.equipment}
            onChange={(event) => updateProfile({ equipment: event.target.value })}
            placeholder="Gym access, home equipment, or activities you enjoy"
          />,
        )}
        {renderField(
          'Constraints and preferences',
          'profile-constraints',
          <Textarea
            id="profile-constraints"
            rows={2}
            maxLength={3000}
            value={profile.constraints}
            onChange={(event) => updateProfile({ constraints: event.target.value })}
            placeholder="Time limits, movements to avoid, scheduling needs, or preferences"
          />,
        )}
      </section>
      <section className="profile-section">
        <h2>Food preferences</h2>
        {renderField(
          'Dietary needs and preferences',
          'profile-dietary-preferences',
          <Textarea
            id="profile-dietary-preferences"
            rows={2}
            maxLength={2000}
            value={profile.dietaryPreferences}
            onChange={(event) => updateProfile({ dietaryPreferences: event.target.value })}
            placeholder="Allergies, foods you avoid, and foods you enjoy"
          />,
        )}
        {renderField(
          'Groceries and meal prep',
          'profile-grocery-preferences',
          <Textarea
            id="profile-grocery-preferences"
            rows={2}
            maxLength={1000}
            value={profile.groceryPreferences}
            onChange={(event) => updateProfile({ groceryPreferences: event.target.value })}
            placeholder="Where you shop, your budget, cooking time, and how often you prep"
          />,
        )}
      </section>
      <section className="profile-section">
        <h2>Nutrition targets</h2>
        <Label htmlFor="profile-targets-set" className="standalone-checkbox cursor-pointer">
          <Checkbox
            id="profile-targets-set"
            checked={targetsSet}
            onCheckedChange={(checked) => setTargetsSet(Boolean(checked))}
          />
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
                        <Input
                          id={`macro-${kind}-${metric.key}`}
                          aria-label={`${kind === 'training' ? 'Training' : 'Recovery'} ${metric.label}`}
                          type="number"
                          min={0}
                          max={metric.max}
                          step="any"
                          required
                          value={draft[kind][metric.key]}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              [kind]: { ...draft[kind], [metric.key]: Number(event.target.value) },
                            })
                          }
                        />,
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
            const activity = draft.schedule[String(day)] || 'rest';
            return (
              <Field className="field" key={day}>
                <FieldLabel htmlFor={`schedule-day-${day}`}>{weekdays[day]}</FieldLabel>
                <NativeSelect
                  id={`schedule-day-${day}`}
                  value={activity}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      schedule: { ...draft.schedule, [String(day)]: event.target.value },
                    })
                  }
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
          })}
        </div>
      </section>
      {error && (
        <Alert variant="destructive" className="form-error">
          {error}
        </Alert>
      )}
      <div className="profile-save">
        <Button variant="default" type="submit" disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
          {busy ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}
