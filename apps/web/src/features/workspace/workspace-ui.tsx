import type { ComponentProps, ReactNode } from 'react';
import type { Macros } from '@packages/nutrition/types';
import { mondayOf, shiftDate } from '@packages/nutrition/dates';
import { Home, UtensilsCrossed, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Button,
  Label,
  Input,
  Dialog as SharedDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Empty as SharedEmpty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Progress as SharedProgress,
} from '@packages/ui';
import { num, formatDate, macroNames } from './utils';

export function ResourceStatus({
  error,
  retry,
  loading = false,
}: {
  error?: Error | null;
  retry: () => void;
  loading?: boolean;
}) {
  return (
    <div aria-live="polite">
      <p role={error ? 'alert' : 'status'}>
        {error?.message ?? (loading ? 'Loading your saved data…' : '')}
      </p>
      {error && (
        <Button variant="outline" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function ResourcePaging({
  hasPrevious,
  hasNext,
  busy,
  previous,
  next,
}: {
  hasPrevious: boolean;
  hasNext: boolean;
  busy: boolean;
  previous: () => void;
  next: () => void;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav aria-label="Results pages" className="button-row">
      <Button variant="outline" disabled={busy || !hasPrevious} onClick={previous}>
        Previous page
      </Button>
      <Button variant="outline" disabled={busy || !hasNext} onClick={next}>
        Next page
      </Button>
    </nav>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  );
}
export function Empty({
  icon: Icon = UtensilsCrossed,
  title,
  children,
  action,
}: {
  icon?: typeof Home;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <SharedEmpty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon size={23} strokeWidth={1.5} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </SharedEmpty>
  );
}
export function MacroLine({ nutrition, servings = 1 }: { nutrition: Macros; servings?: number }) {
  return (
    <span className="macro-line">
      <b>
        {num(nutrition.calories * servings)} <span>kcal</span>
      </b>
      <span>{num(nutrition.protein * servings)}g P</span>
      <span>{num(nutrition.carbs * servings)}g C</span>
      <span>{num(nutrition.fat * servings)}g F</span>
    </span>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <Label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </Label>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <SharedDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="corner-ui"
        style={wide ? { width: 'min(820px, calc(100vw - 32px))' } : undefined}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </SharedDialog>
  );
}
export function DateControls({
  date,
  setDate,
  week = false,
}: {
  date: string;
  setDate: (date: string) => void;
  week?: boolean;
}) {
  const start = mondayOf(date);
  return (
    <div className="date-control">
      <IconButton
        label={week ? 'Previous week' : 'Previous day'}
        onClick={() => setDate(shiftDate(date, week ? -7 : -1))}
      >
        <ChevronLeft size={17} />
      </IconButton>
      <span>
        {week
          ? `${formatDate(start, { month: 'short', day: 'numeric' })} – ${formatDate(shiftDate(start, 6), { month: 'short', day: 'numeric', year: 'numeric' })}`
          : formatDate(date, { month: 'short', day: 'numeric', year: 'numeric' })}
      </span>
      <IconButton
        label={week ? 'Next week' : 'Next day'}
        onClick={() => setDate(shiftDate(date, week ? 7 : 1))}
      >
        <ChevronRight size={17} />
      </IconButton>
    </div>
  );
}
export function Progress({
  value,
  target,
  label,
  targetsSet = true,
}: {
  value: number;
  target: number;
  label: string;
  targetsSet?: boolean;
}) {
  const pct = targetsSet && target > 0 ? Math.min((value / target) * 100, 100) : 0;
  return (
    <div className="macro-progress">
      <div className="macro-progress-heading">
        <span>
          <i />
          {label}
        </span>
        <b>
          {num(value)}
          <small>{targetsSet && target > 0 ? ` / ${num(target)} g` : ' g logged'}</small>
        </b>
      </div>
      {targetsSet && <SharedProgress value={pct} aria-label={label} />}
    </div>
  );
}

export function MacroFields({
  value,
  onChange,
  onBlur,
}: {
  value: Macros;
  onChange: (value: Macros) => void;
  onBlur?: () => void;
}) {
  return (
    <div className="macro-fields">
      {Object.entries(macroNames).map(([key, label]) => (
        <Field label={`${label}${key === 'calories' ? ' (kcal)' : ' (g)'}`} key={key}>
          <Input
            required
            type="number"
            min={0}
            max={key === 'calories' ? 10000 : key === 'carbs' ? 2500 : 1500}
            step="any"
            value={value[key as keyof Macros]}
            onBlur={onBlur}
            onChange={(e) => onChange({ ...value, [key]: Number(e.target.value) })}
          />
        </Field>
      ))}
    </div>
  );
}
