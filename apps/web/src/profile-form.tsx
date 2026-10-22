import { useState, type FormEvent } from 'react';
import { Check, Loader2, SlidersHorizontal } from 'lucide-react';
import type { Macros, Settings } from '@corner/shared/types';
import { SettingsSchema } from '@corner/shared/domain';
import { DEFAULT_PROFILE } from '@corner/shared/seed';

const metrics: Array<{ key: keyof Macros; label: string; max: number }> = [
  { key: 'calories', label: 'Calories · kcal', max: 10000 },
  { key: 'protein', label: 'Protein · g', max: 1500 },
  { key: 'carbs', label: 'Carbs · g', max: 2500 },
  { key: 'fat', label: 'Fat · g', max: 1500 },
];
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const field = (label: string, children: React.ReactNode, hint?: string) => <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;

export default function ProfileForm({ settings, busy, onSave, setup = false }: {
  settings: Settings; busy: boolean; onSave: (settings: Settings) => Promise<boolean | void>; setup?: boolean;
}) {
  const [draft, setDraft] = useState<Settings>(() => ({ ...structuredClone(settings), profile: { ...DEFAULT_PROFILE, ...settings.profile } }));
  const [targetsSet, setTargetsSet] = useState(settings.setup?.nutritionTargetsSet ?? (settings.training.calories > 0 && settings.rest.calories > 0));
  const [error, setError] = useState('');
  const profile = draft.profile!;
  const updateProfile = (values: Partial<NonNullable<Settings['profile']>>) => setDraft(current => ({ ...current, profile: { ...current.profile!, ...values } }));
  const zones = [...new Set([draft.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'])];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (targetsSet && (draft.training.calories <= 0 || draft.rest.calories <= 0)) { setError('Enter calories for both training and recovery days, or leave nutrition targets unset for now.'); return; }
    const next = { ...draft, setup: { completedAt: draft.setup?.completedAt || new Date().toISOString(), nutritionTargetsSet: targetsSet } };
    const parsed = SettingsSchema.safeParse(next);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || 'Check the highlighted values.'); return; }
    try { await onSave(parsed.data); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Your profile could not be saved.'); }
  }
  return <form className="standalone-profile" onSubmit={submit}>
    <section className="profile-section">
      <div className="section-heading"><h2>{setup ? 'Make Corner yours' : 'Your profile'}</h2><SlidersHorizontal size={18} /></div>
      <p className="profile-help">Your plans and agent use the details you enter here. You can update them at any time.</p>
      <div className="form-two">
        {field('Preferred name', <input value={draft.name} maxLength={80} required autoComplete="given-name" onChange={event => setDraft({ ...draft, name: event.target.value })} />)}
        {field('Time zone', <select value={draft.timezone} onChange={event => setDraft({ ...draft, timezone: event.target.value })}>{zones.map(zone => <option key={zone} value={zone}>{zone.replaceAll('_', ' ')}</option>)}</select>)}
      </div>
      {field('What are you working toward?', <textarea rows={2} maxLength={2000} value={profile.goals} onChange={event => updateProfile({ goals: event.target.value })} placeholder="Your goals, priorities, or what you want to feel better at" />, 'Optional. Use your own words.')}
      <div className="form-three">
        {field('Training experience', <select value={profile.experience} onChange={event => updateProfile({ experience: event.target.value })}><option value="">Not specified</option>{['Getting started', 'Returning to training', 'Training regularly', 'Experienced'].map(value => <option key={value}>{value}</option>)}{profile.experience && !['Getting started', 'Returning to training', 'Training regularly', 'Experienced'].includes(profile.experience) && <option>{profile.experience}</option>}</select>)}
        {field('Typical session · min', <input type="number" min={5} max={600} step={5} required value={profile.sessionMinutes} onChange={event => updateProfile({ sessionMinutes: Number(event.target.value) })} />)}
        {field('Workout weights', <select value={profile.defaultWorkoutUnit} onChange={event => updateProfile({ defaultWorkoutUnit: event.target.value as 'lb' | 'kg' })}><option value="lb">Pounds · lb</option><option value="kg">Kilograms · kg</option></select>)}
      </div>
      {field('Equipment available', <textarea rows={2} maxLength={2000} value={profile.equipment} onChange={event => updateProfile({ equipment: event.target.value })} placeholder="Gym access, home equipment, or activities you enjoy" />)}
      {field('Constraints and preferences', <textarea rows={2} maxLength={3000} value={profile.constraints} onChange={event => updateProfile({ constraints: event.target.value })} placeholder="Time limits, movements to avoid, scheduling needs, or preferences" />)}
    </section>
    <section className="profile-section">
      <h2>Food preferences</h2>
      {field('Dietary needs and preferences', <textarea rows={2} maxLength={2000} value={profile.dietaryPreferences} onChange={event => updateProfile({ dietaryPreferences: event.target.value })} placeholder="Allergies, foods you avoid, and foods you enjoy" />)}
      {field('Groceries and meal prep', <textarea rows={2} maxLength={1000} value={profile.groceryPreferences} onChange={event => updateProfile({ groceryPreferences: event.target.value })} placeholder="Where you shop, your budget, cooking time, and how often you prep" />)}
    </section>
    <section className="profile-section">
      <h2>Nutrition targets</h2>
      <label className="standalone-checkbox"><input type="checkbox" checked={targetsSet} onChange={event => setTargetsSet(event.target.checked)} /><span>I want to set my daily targets</span></label>
      <p className="profile-help">Enter targets you have chosen. You can track food and plan meals before setting targets.</p>
      {targetsSet && <div className="profile-targets">{(['training', 'rest'] as const).map(kind => <div key={kind}><h3>{kind === 'training' ? 'Training days' : 'Recovery days'}</h3><div className="profile-macro-grid">{metrics.map(metric => <div key={metric.key}>{field(metric.label, <input aria-label={`${kind === 'training' ? 'Training' : 'Recovery'} ${metric.label}`} type="number" min={0} max={metric.max} step="any" required value={draft[kind][metric.key]} onChange={event => setDraft({ ...draft, [kind]: { ...draft[kind], [metric.key]: Number(event.target.value) } })} />)}</div>)}</div></div>)}</div>}
    </section>
    <section className="profile-section">
      <h2>Your usual week</h2>
      <p className="profile-help">This helps select daily nutrition targets. Add specific workouts in your planner; nothing is logged automatically.</p>
      <div className="profile-week">{[1, 2, 3, 4, 5, 6, 0].map(day => {
        const activity = draft.schedule[String(day)] || 'rest';
        return <label className="field" key={day}><span>{weekdays[day]}</span><select value={activity} onChange={event => setDraft({ ...draft, schedule: { ...draft.schedule, [String(day)]: event.target.value } })}><option value="rest">No regular session</option><option value="strength">Strength</option><option value="conditioning">Conditioning</option><option value="boxing">Boxing</option>{!['rest', 'strength', 'conditioning', 'boxing'].includes(activity) && <option value={activity}>{activity}</option>}</select></label>;
      })}</div>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="profile-save"><button className="button primary" type="submit" disabled={busy}>{busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{busy ? 'Saving…' : setup ? 'Open my workspace' : 'Save profile'}</button></div>
  </form>;
}
