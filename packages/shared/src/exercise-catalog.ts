import exercises from './data/exercises.json' with { type: 'json' };
import source from './data/exercises-source.json' with { type: 'json' };

/** Original source IDs are zero-padded strings. A catalog entry describes a
 * movement; it does not prescribe an individual's weight, reps, or effort. */
export type ExerciseCatalogEntry = {
  id: string;
  name: string;
  category: string;
  equipment: string;
  target: string;
  muscleGroup: string;
  secondaryMuscles: string[];
  instructions: string[];
};

export type ExerciseCatalogSearch = {
  query?: string;
  /** Upstream body-part category, for example "chest" or "upper legs". */
  category?: string;
  equipment?: string;
  target?: string;
  limit?: number;
  offset?: number;
};

export const EXERCISE_CATALOG: readonly ExerciseCatalogEntry[] = exercises;
export const EXERCISE_CATALOG_SOURCE = source;
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const distinct = (values: string[]) => [...new Set(values)].sort(collator.compare);
export const EXERCISE_CATEGORIES = distinct(EXERCISE_CATALOG.map(exercise => exercise.category));
export const EXERCISE_EQUIPMENT = distinct(EXERCISE_CATALOG.map(exercise => exercise.equipment));
export const EXERCISE_TARGETS = distinct(EXERCISE_CATALOG.map(exercise => exercise.target));
const byId = new Map(EXERCISE_CATALOG.map(exercise => [exercise.id, exercise]));

export function getCatalogExercise(id: string): ExerciseCatalogEntry | undefined {
  return byId.get(id);
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bdb\b/g, 'dumbbell').replace(/\bbb\b/g, 'barbell')
    .replace(/\b(?:bw|bodyweight)\b/g, 'body weight')
    .replace(/\bpull\s*ups?\b/g, 'pull up').replace(/\bpush\s*ups?\b/g, 'push up')
    .replace(/\bsit\s*ups?\b/g, 'sit up')
    .replace(/\s+/g, ' ').trim();
}

const index = EXERCISE_CATALOG.map(exercise => ({
  exercise,
  name: normalize(exercise.name),
  category: normalize(exercise.category),
  equipment: normalize(exercise.equipment),
  target: normalize(exercise.target),
  searchable: normalize([exercise.name, exercise.category, exercise.equipment, exercise.target,
    exercise.muscleGroup, ...exercise.secondaryMuscles].join(' ')),
}));

/** Search is local, deterministic, and separate from exercise identity. Search
 * aliases never link different movements or reuse their training history. */
export function searchExerciseCatalog(options: ExerciseCatalogSearch = {}): { exercises: ExerciseCatalogEntry[]; total: number } {
  const query = normalize((options.query ?? '').slice(0, 200));
  const terms = [...new Set(query.split(' ').filter(Boolean))];
  const category = normalize(options.category ?? '');
  const equipment = normalize(options.equipment ?? '');
  const target = normalize(options.target ?? '');
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(100, Math.trunc(options.limit!))) : 30;
  const offset = Number.isFinite(options.offset) ? Math.max(0, Math.trunc(options.offset!)) : 0;
  const matches = index.filter(item => (!category || item.category === category)
    && (!equipment || item.equipment === equipment)
    && (!target || item.target === target)
    && terms.every(term => item.searchable.includes(term)));
  const rank = (name: string) => !query ? 0 : name === query ? 100
    : name.startsWith(query) ? 80 : name.includes(query) ? 60
    : terms.every(term => name.includes(term)) ? 40 : 0;
  matches.sort((left, right) => rank(right.name) - rank(left.name)
    || collator.compare(left.exercise.name, right.exercise.name)
    || left.exercise.id.localeCompare(right.exercise.id));
  return { exercises: matches.slice(offset, offset + limit).map(item => item.exercise), total: matches.length };
}
