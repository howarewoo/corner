'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, Dumbbell, Loader2, Plus, Search, X } from 'lucide-react';
import type { ExerciseCatalogEntry } from '@packages/shared/exercise-catalog';
import type * as ExerciseCatalog from '@packages/shared/exercise-catalog';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  Field,
  FieldLabel,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  NativeSelect,
  NativeSelectOption,
} from '@packages/ui';
import './exercise-picker.css';

type Catalog = typeof ExerciseCatalog;
const label = (value: string) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value);

function useCatalog() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    import('@packages/shared/exercise-catalog')
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return { catalog, error, retry: () => setAttempt((value) => value + 1) };
}

export default function ExercisePicker({
  onSelect,
  onCustom,
  onClose,
  replacing = false,
}: {
  onSelect: (exercise: ExerciseCatalogEntry) => void;
  onCustom: () => void;
  onClose: () => void;
  replacing?: boolean;
}) {
  const { catalog, error, retry } = useCatalog();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [equipment, setEquipment] = useState('');
  const [limit, setLimit] = useState(12);
  const searchRef = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => catalog?.searchExerciseCatalog({ query, category, equipment, limit }),
    [catalog, query, category, equipment, limit],
  );
  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  return (
    <section className="exercise-picker corner-ui" aria-label="Exercise database">
      <div className="exercise-picker-heading">
        <div>
          <span className="training-eyebrow">Exercise library</span>
          <h3>{replacing ? 'Choose a replacement' : 'Find your next exercise'}</h3>
          <p>Search by exercise, muscle, or equipment.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close exercise library"
          onClick={onClose}
        >
          <X size={19} />
        </Button>
      </div>

      <FieldLabel className="exercise-search-label w-full">
        <span className="sr-only">Search exercises</span>
        <InputGroup className="exercise-search">
          <InputGroupAddon>
            <Search size={18} />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            type="search"
            aria-label="Search exercises"
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(12);
            }}
            placeholder="Try dumbbell bench press…"
            maxLength={160}
          />
        </InputGroup>
      </FieldLabel>

      <div className="exercise-filters">
        <Field>
          <FieldLabel className="field w-full">
            <span>Body part</span>
            <NativeSelect
              aria-label="Body part"
              className="w-full"
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setLimit(12);
              }}
            >
              <NativeSelectOption value="">All body parts</NativeSelectOption>
              {catalog?.EXERCISE_CATEGORIES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {label(value)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FieldLabel>
        </Field>
        <Field>
          <FieldLabel className="field w-full">
            <span>Equipment</span>
            <NativeSelect
              aria-label="Equipment"
              className="w-full"
              value={equipment}
              onChange={(event) => {
                setEquipment(event.target.value);
                setLimit(12);
              }}
            >
              <NativeSelectOption value="">All equipment</NativeSelectOption>
              {catalog?.EXERCISE_EQUIPMENT.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {label(value)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FieldLabel>
        </Field>
      </div>

      <div className="exercise-results-status" role="status">
        {error ? (
          <span>
            Couldn’t load the library.{' '}
            <Button
              type="button"
              variant="link"
              size="sm"
              className="p-0 h-auto font-medium"
              onClick={retry}
            >
              Try again
            </Button>
          </span>
        ) : !catalog ? (
          <span>
            <Loader2 size={16} className="spin" />
            Loading exercise library…
          </span>
        ) : (
          <span>
            {results?.total.toLocaleString()} {results?.total === 1 ? 'exercise' : 'exercises'}
            {query || category || equipment ? ' found' : ' in the database'}
          </span>
        )}
      </div>

      <div className="exercise-results">
        {results?.exercises.map((exercise) => (
          <article className="exercise-result" key={exercise.id}>
            <div className="exercise-result-main">
              <Dumbbell size={19} />
              <div>
                <h4>{label(exercise.name)}</h4>
                <p>
                  {label(exercise.equipment)} · {label(exercise.target)}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSelect(exercise)}
                aria-label={`${replacing ? 'Use' : 'Add'} ${exercise.name}`}
              >
                <Plus size={15} />
                {replacing ? 'Use' : 'Add'}
              </Button>
            </div>
            <Collapsible className="exercise-instructions">
              <CollapsibleTrigger className="exercise-instructions-trigger">
                <BookOpen size={14} />
                How to perform
                <ChevronDown size={14} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ol>
                  {exercise.instructions.map((instruction, index) => (
                    <li key={index}>{instruction}</li>
                  ))}
                </ol>
                {exercise.secondaryMuscles.length > 0 && (
                  <p>Also works: {exercise.secondaryMuscles.join(', ')}.</p>
                )}
              </CollapsibleContent>
            </Collapsible>
          </article>
        ))}
      </div>

      {results?.total === 0 && (
        <Empty className="exercise-search-empty">
          <EmptyHeader>
            <EmptyMedia>
              <Search size={22} />
            </EmptyMedia>
            <EmptyDescription>
              No matching exercises. Try fewer words or clear a filter.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery('');
                setCategory('');
                setEquipment('');
                setLimit(12);
              }}
            >
              Clear search
            </Button>
          </EmptyContent>
        </Empty>
      )}

      {results && results.exercises.length < results.total && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => setLimit((value) => Math.min(100, value + 12))}
          disabled={limit >= 100}
        >
          {limit >= 100 ? 'Narrow your search to see more' : 'Show more exercises'}
        </Button>
      )}

      <div className="exercise-picker-footer">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="inline-link p-0 h-auto font-medium"
          onClick={onCustom}
        >
          <Plus size={15} />
          Use a custom exercise
        </Button>
        <span>
          Data:{' '}
          <a
            href="https://github.com/hasaneyldrm/exercises-dataset"
            target="_blank"
            rel="noreferrer"
          >
            exercises-dataset
          </a>{' '}
          ·{' '}
          <a href="/licenses/exercises-dataset-LICENSE.txt" target="_blank" rel="noreferrer">
            MIT license
          </a>
        </span>
      </div>
    </section>
  );
}

function CatalogDetails({ id }: { id: string }) {
  const { catalog, error, retry } = useCatalog();
  const exercise = catalog?.getCatalogExercise(id);
  if (error)
    return (
      <p className="training-help">
        Couldn’t load the exercise.{' '}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="p-0 h-auto font-medium"
          onClick={retry}
        >
          Try again
        </Button>
      </p>
    );
  if (!catalog)
    return (
      <p className="training-help" role="status">
        Loading instructions…
      </p>
    );
  if (!exercise)
    return (
      <p className="training-help">
        This exercise is no longer in the current catalog. Your saved exercise and workout history
        are still available.
      </p>
    );
  return (
    <div className="exercise-reference-content">
      <p>
        <b>{label(exercise.target)}</b> · {label(exercise.equipment)}
        {exercise.secondaryMuscles.length > 0
          ? ` · Also works ${exercise.secondaryMuscles.join(', ')}`
          : ''}
      </p>
      <ol>
        {exercise.instructions.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      <a href="https://github.com/hasaneyldrm/exercises-dataset" target="_blank" rel="noreferrer">
        Exercise instructions from exercises-dataset
      </a>
    </div>
  );
}

export function ExerciseReference({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="exercise-reference">
      <CollapsibleTrigger className="exercise-reference-trigger">
        <BookOpen size={15} />
        {open ? 'Hide exercise instructions' : 'Exercise instructions'}
        {open ? <Check size={14} /> : <ChevronDown size={14} />}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CatalogDetails id={id} />
      </CollapsibleContent>
    </Collapsible>
  );
}
