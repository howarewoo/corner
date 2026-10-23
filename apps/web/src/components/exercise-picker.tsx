"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, Dumbbell, Loader2, Plus, Search, X } from 'lucide-react';
import type { ExerciseCatalogEntry } from '@packages/shared/exercise-catalog';
import './exercise-picker.css';

type Catalog = typeof import('@packages/shared/exercise-catalog');
const label = (value: string) => value ? value.charAt(0).toUpperCase() + value.slice(1) : value;

function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    import('@packages/shared/exercise-catalog').then(value => { if (active) setCatalog(value); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  return { catalog, error, retry: () => setAttempt(value => value + 1) };
}

export default function ExercisePicker({ onSelect, onCustom, onClose, replacing = false }: { onSelect: (exercise: ExerciseCatalogEntry) => void; onCustom: () => void; onClose: () => void; replacing?: boolean }) {
  const { catalog, error, retry } = useCatalog();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [equipment, setEquipment] = useState('');
  const [limit, setLimit] = useState(12);
  const searchRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => catalog?.searchExerciseCatalog({ query, category, equipment, limit }), [catalog, query, category, equipment, limit]);
  useEffect(() => { searchRef.current?.focus(); searchRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, []);
  return <section className="exercise-picker" aria-label="Exercise database">
    <div className="exercise-picker-heading"><div><span className="training-eyebrow">Exercise library</span><h3>{replacing ? 'Choose a replacement' : 'Find your next exercise'}</h3><p>Search by exercise, muscle, or equipment.</p></div><button type="button" className="icon-button" aria-label="Close exercise library" onClick={onClose}><X size={19} /></button></div>
    <label className="exercise-search"><Search size={18} /><span className="sr-only">Search exercises</span><input ref={searchRef} type="search" onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} placeholder="Try dumbbell bench press…" maxLength={160} /></label>
    <div className="exercise-filters"><label className="field"><span>Body part</span><select aria-label="Body part" value={category} onChange={event => { setCategory(event.target.value); setLimit(12); }}><option value="">All body parts</option>{catalog?.EXERCISE_CATEGORIES.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label><label className="field"><span>Equipment</span><select aria-label="Equipment" value={equipment} onChange={event => { setEquipment(event.target.value); setLimit(12); }}><option value="">All equipment</option>{catalog?.EXERCISE_EQUIPMENT.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label></div>
    <div className="exercise-results-status" role="status">{error ? <span>Couldn’t load the library. <button type="button" className="text-link" onClick={retry}>Try again</button></span> : !catalog ? <span><Loader2 size={16} className="spin" />Loading exercise library…</span> : <span>{results?.total.toLocaleString()} {results?.total === 1 ? 'exercise' : 'exercises'}{query || category || equipment ? ' found' : ' in the database'}</span>}</div>
    <div className="exercise-results">{results?.exercises.map(exercise => <article className="exercise-result" key={exercise.id}><div className="exercise-result-main"><Dumbbell size={19} /><div><h4>{label(exercise.name)}</h4><p>{label(exercise.equipment)} · {label(exercise.target)}</p></div><button type="button" className="button outline small" onClick={() => onSelect(exercise)} aria-label={`${replacing ? 'Use' : 'Add'} ${exercise.name}`}><Plus size={15} />{replacing ? 'Use' : 'Add'}</button></div><details className="exercise-instructions"><summary><BookOpen size={14} />How to perform <ChevronDown size={14} /></summary><ol>{exercise.instructions.map((instruction, index) => <li key={index}>{instruction}</li>)}</ol>{exercise.secondaryMuscles.length > 0 && <p>Also works: {exercise.secondaryMuscles.join(', ')}.</p>}</details></article>)}</div>
    {results?.total === 0 && <div className="exercise-search-empty"><Search size={22} /><p>No matching exercises. Try fewer words or clear a filter.</p><button type="button" className="button subtle small" onClick={() => { setQuery(''); setCategory(''); setEquipment(''); setLimit(12); }}>Clear search</button></div>}
    {results && results.exercises.length < results.total && <button type="button" className="button outline full-width" onClick={() => setLimit(value => Math.min(100, value + 12))} disabled={limit >= 100}>{limit >= 100 ? 'Narrow your search to see more' : 'Show more exercises'}</button>}
    <div className="exercise-picker-footer"><button type="button" className="text-link inline-link" onClick={onCustom}><Plus size={15} />Use a custom exercise</button><span>Data: <a href="https://github.com/hasaneyldrm/exercises-dataset" target="_blank" rel="noreferrer">exercises-dataset</a> · <a href="/licenses/exercises-dataset-LICENSE.txt" target="_blank" rel="noreferrer">MIT license</a></span></div>
  </section>;
}

function CatalogDetails({ id }: { id: string }) {
  const { catalog, error, retry } = useCatalog();
  const exercise = catalog?.getCatalogExercise(id);
  if (error) return <p className="training-help">Couldn’t load the exercise. <button type="button" className="text-link" onClick={retry}>Try again</button></p>;
  if (!catalog) return <p className="training-help" role="status">Loading instructions…</p>;
  if (!exercise) return <p className="training-help">This exercise is no longer in the current catalog. Your saved exercise and workout history are still available.</p>;
  return <div className="exercise-reference-content"><p><b>{label(exercise.target)}</b> · {label(exercise.equipment)}{exercise.secondaryMuscles.length > 0 ? ` · Also works ${exercise.secondaryMuscles.join(', ')}` : ''}</p><ol>{exercise.instructions.map((step, index) => <li key={index}>{step}</li>)}</ol><a href="https://github.com/hasaneyldrm/exercises-dataset" target="_blank" rel="noreferrer">Exercise instructions from exercises-dataset</a></div>;
}

export function ExerciseReference({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return <div className="exercise-reference"><button type="button" className="text-link inline-link" aria-expanded={open} onClick={() => setOpen(value => !value)}><BookOpen size={15} />{open ? 'Hide exercise instructions' : 'Exercise instructions'}{open ? <Check size={14} /> : <ChevronDown size={14} />}</button>{open && <CatalogDetails id={id} />}</div>;
}
