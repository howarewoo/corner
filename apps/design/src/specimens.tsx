import { useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Info,
  Loader2,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Progress,
  ProgressLabel,
  ProgressValue,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@packages/ui';
import './specimens.css';
import { coreCatalog } from './catalog';
import { ExpandedSpecimen } from './expanded-specimens';
import { InputExamples } from './input-specimen';
import { Section, Status } from './specimen-layout';

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="specimen-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
const units = [
  { value: 'kg', label: 'Kilograms (kg)' },
  { value: 'lb', label: 'Pounds (lb)' },
  { value: 'stone', label: 'Stone (unavailable)' },
];
const colors = [
  {
    label: 'Forest',
    token: '--primary',
    purpose: 'Primary actions',
    foreground: '--primary-foreground',
  },
  {
    label: 'Sage',
    token: '--accent',
    purpose: 'Selected surfaces',
    foreground: '--accent-foreground',
  },
  {
    label: 'Paper',
    token: '--background',
    purpose: 'Primary shells',
    foreground: '--foreground',
  },
  {
    label: 'Soft',
    token: '--muted',
    purpose: 'Quiet sections',
    foreground: '--muted-foreground',
  },
  {
    label: 'Canvas',
    token: '--backdrop',
    purpose: 'Behind the workspace',
    foreground: '--foreground',
  },
  {
    label: 'Editable',
    token: '--control-bg',
    purpose: 'Inputs and selection',
    foreground: '--control-fg',
  },
  {
    label: 'Warning',
    token: '--warning-surface',
    purpose: 'Needs review',
    foreground: '--warning-text',
  },
  {
    label: 'Danger',
    token: '--danger-surface',
    purpose: 'Errors and removal',
    foreground: '--danger-text',
  },
];

function CoreSpecimen({ id }: { id: string }) {
  const [status, setStatus] = useState('Try an action. Changes stay in this preview.');
  const [checked, setChecked] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [choice, setChoice] = useState('strength');
  const [unit, setUnit] = useState<string | null>('kg');
  const [progress, setProgress] = useState(3);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('Upper body');
  const [draft, setDraft] = useState(name);
  const [tab, setTab] = useState('training');
  switch (id) {
    case 'colors':
      return (
        <>
          <Section
            title="The Corner palette"
            description="Switch appearance in the Storybook preview toolbar to inspect the same semantic roles in dark mode."
          >
            <div className="color-grid">
              {colors.map((color) => (
                <div className="color-specimen" key={color.token}>
                  <div
                    className="color-chip"
                    style={{
                      background: `var(${color.token})`,
                      color: `var(${color.foreground})`,
                    }}
                  >
                    <span>Aa</span>
                    <Check size={18} />
                  </div>
                  <h3>{color.label}</h3>
                  <p>{color.purpose}</p>
                  <code>{color.token}</code>
                </div>
              ))}
            </div>
          </Section>
          <Section title="A surface has a job" description="The same palette, used with restraint.">
            <div className="surface-example">
              <div>
                <Badge variant="secondary">Illustrative preview</Badge>
                <h3>Make room for your next step.</h3>
                <p>
                  White shells hold the task. Sage brings related content together. Forest points to
                  the next action.
                </p>
                <Button
                  onClick={() =>
                    setStatus('You chose the primary action. Nothing was saved to Corner.')
                  }
                >
                  Continue <ArrowRight size={16} />
                </Button>
              </div>
              <div className="surface-inset">
                <span>Flat by default</span>
                <p>
                  Tone and spacing create hierarchy. Focus gets an outline; ordinary panels do not
                  need a shadow.
                </p>
              </div>
            </div>
            <Status>{status}</Status>
          </Section>
        </>
      );
    case 'typography':
      return (
        <>
          <Section
            title="An everyday hierarchy"
            description="The operating system’s sans-serif stack. No external font request."
          >
            <div className="type-samples">
              <div>
                <span>Page heading · 38 / 1.22 · 600</span>
                <p className="type-page">Your everyday practice.</p>
              </div>
              <div>
                <span>Section heading · 22 / 1.3 · 600</span>
                <p className="type-section">A little progress, every day.</p>
              </div>
              <div>
                <span>Body · 15 / 1.55 · 400</span>
                <p className="type-body">
                  Plan what comes next. Record what actually happened. Keep the details clear enough
                  to adjust tomorrow.
                </p>
              </div>
              <div>
                <span>Supporting · 13 / 1.55 · 400</span>
                <p className="type-support">
                  Nutrition is an estimate. Check product labels and portions.
                </p>
              </div>
            </div>
          </Section>
          <Section title="Quantities need context">
            <div className="quantity-example">
              <span>
                <strong>120</strong> / 150 g protein
              </span>
              <span>
                <strong>22.5</strong> kg per hand
              </span>
              <span>
                <strong>8</strong> reps recorded
              </span>
            </div>
            <p className="specimen-note">
              Illustrative values · tabular numerals keep changing quantities aligned. Units and
              planned versus recorded meaning stay visible.
            </p>
          </Section>
        </>
      );
    case 'spacing':
      return (
        <>
          <Section
            title="Spacing rhythm"
            description="Small gaps join related controls. Larger gaps separate tasks."
          >
            <div className="spacing-samples">
              {[4, 8, 12, 16, 20, 24, 32, 40].map((value) => (
                <div key={value}>
                  <span>{value} px</span>
                  <i style={{ width: value * 4 }} />
                  <small>
                    {value <= 12
                      ? 'Within a group'
                      : value <= 24
                        ? 'Between elements'
                        : 'Between sections'}
                  </small>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Shapes, by purpose">
            <div className="shape-samples">
              {[
                { radius: 14, label: 'Controls' },
                { radius: 24, label: 'Panels' },
                { radius: 30, label: 'Outer shells' },
              ].map((shape) => (
                <div key={shape.label}>
                  <div style={{ borderRadius: shape.radius }}>{shape.radius} px</div>
                  <span>{shape.label}</span>
                </div>
              ))}
            </div>
          </Section>
        </>
      );
    case 'button':
      return (
        <>
          <Section
            title="Action hierarchy"
            description="One primary action. Supporting and destructive actions have distinct roles."
          >
            <div className="specimen-row">
              <Button onClick={() => setStatus('Preview saved locally.')}>Save changes</Button>
              <Button variant="secondary" onClick={() => setStatus('Secondary action selected.')}>
                Secondary
              </Button>
              <Button
                variant="outline"
                onClick={() => setStatus('Changes cancelled in this preview.')}
              >
                Cancel
              </Button>
              <Button variant="ghost" onClick={() => setStatus('More options selected.')}>
                Ghost
              </Button>
              <Button
                variant="destructive"
                onClick={() => setStatus('Sample removed from this preview.')}
              >
                Remove
              </Button>
              <Button variant="link" onClick={() => setStatus('Link-style action selected.')}>
                View details
              </Button>
            </div>
            <Status>{status}</Status>
          </Section>
          <Section title="Sizes & icons">
            <div className="specimen-row">
              <Button size="sm" onClick={() => setStatus('Small action selected.')}>
                Small
              </Button>
              <Button onClick={() => setStatus('Default action selected.')}>Default</Button>
              <Button size="lg" onClick={() => setStatus('Large action selected.')}>
                Large <ArrowRight />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Add sample"
                onClick={() => setStatus('Sample added to this preview.')}
              >
                <Plus />
              </Button>
            </div>
          </Section>
          <Section
            title="Unavailable & busy"
            description="Disabled controls cannot activate. Busy state is an illustrative specimen, not a network request."
          >
            <div className="specimen-row">
              <Button disabled>Save changes</Button>
              <Button disabled aria-busy="true">
                <Loader2 />
                Saving…
              </Button>
            </div>
          </Section>
        </>
      );
    case 'input':
      return (
        <>
          <Section title="Editable & invalid">
            <div className="specimen-grid">
              <Field label="Workout name" hint="Name the session so you can find it later.">
                <Input id="input-workout-name" placeholder="e.g. Upper body" />
              </Field>
              <label className="specimen-field">
                <span>Duration in minutes</span>
                <Input
                  id="input-duration"
                  type="number"
                  defaultValue={-5}
                  aria-invalid="true"
                  aria-describedby="input-duration-error"
                />
                <small id="input-duration-error" className="specimen-error">
                  Enter a duration greater than zero.
                </small>
              </label>
            </div>
          </Section>
          <Section
            title="Read-only & disabled"
            description="Pale surfaces distinguish unavailable fields from editable ones."
          >
            <div className="specimen-grid">
              <Field label="Recorded unit">
                <Input id="input-recorded-unit" readOnly value="Kilograms (kg)" />
              </Field>
              <Field label="Previous session">
                <Input id="input-previous-session" disabled value="No previous session" />
              </Field>
            </div>
          </Section>
          <InputExamples />
        </>
      );
    case 'textarea':
      return (
        <>
          <Section title="Notes">
            <div className="specimen-grid">
              <Field label="Session notes" hint="Add context that numbers alone cannot capture.">
                <Textarea placeholder="How did the session feel?" />
              </Field>
              <label className="specimen-field">
                <span>Notes needing review</span>
                <Textarea
                  defaultValue=""
                  placeholder="Add a little more detail…"
                  aria-invalid="true"
                  aria-describedby="notes-error"
                />
                <small id="notes-error" className="specimen-error">
                  Add the details needed to review this sample.
                </small>
              </label>
            </div>
          </Section>
          <Section title="Unavailable">
            <div className="specimen-grid">
              <Field label="Read-only note">
                <Textarea
                  readOnly
                  value="A comfortable session. Keep the same targets next time."
                />
              </Field>
              <Field label="Disabled note">
                <Textarea disabled value="No note available." />
              </Field>
            </div>
          </Section>
        </>
      );
    case 'checkbox':
      return (
        <>
          <Section title="Independent choices">
            <div className="specimen-stack">
              <label className="choice-label">
                <Checkbox checked={checked} onCheckedChange={setChecked} />
                <span>Include a warm-up</span>
              </label>
              <label className="choice-label">
                <Checkbox defaultChecked={false} />
                <span>Include mobility work</span>
              </label>
              <label className="choice-label">
                <Checkbox disabled />
                <span>Share with a coach (unavailable)</span>
              </label>
              <label className="choice-label">
                <Checkbox disabled defaultChecked />
                <span>Keep recorded activity (required)</span>
              </label>
            </div>
            <Status>Warm-up {checked ? 'included' : 'not included'} in this preview.</Status>
          </Section>
        </>
      );
    case 'switch':
      return (
        <>
          <Section title="Immediate preferences">
            <div className="specimen-stack">
              <label className="choice-label">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                <span>Show rest timers</span>
              </label>
              <label className="choice-label">
                <Switch defaultChecked />
                <span>Show load units</span>
              </label>
              <label className="choice-label">
                <Switch disabled />
                <span>Coach notifications (unavailable)</span>
              </label>
            </div>
            <Status>Rest timers are {enabled ? 'on' : 'off'} in this preview.</Status>
          </Section>
        </>
      );
    case 'radio-group':
      return (
        <>
          <Section
            title="One training focus"
            description="Arrow keys move between available options."
          >
            <RadioGroup
              aria-label="Training focus"
              value={choice}
              onValueChange={(value) => setChoice(String(value))}
            >
              <label className="choice-label">
                <RadioGroupItem value="strength" />
                <span>Strength</span>
              </label>
              <label className="choice-label">
                <RadioGroupItem value="conditioning" />
                <span>Conditioning</span>
              </label>
              <label className="choice-label">
                <RadioGroupItem value="coached" disabled />
                <span>Coached program (unavailable)</span>
              </label>
            </RadioGroup>
            <Status>Selected: {choice}.</Status>
          </Section>
        </>
      );
    case 'select':
      return (
        <>
          <Section
            title="Load units"
            description="Open with Enter or Space; use arrows to select, Escape to dismiss."
          >
            <div className="specimen-narrow">
              <label id="unit-label" className="specimen-label">
                Record load in
              </label>
              <Select items={units} value={unit} onValueChange={setUnit}>
                <SelectTrigger aria-labelledby="unit-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {units.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                      disabled={option.value === 'stone'}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Status>Selected unit: {unit}.</Status>
            </div>
          </Section>
          <Section title="Unavailable">
            <div className="specimen-narrow">
              <label id="disabled-unit-label" className="specimen-label">
                Recorded session unit
              </label>
              <Select items={units} value="kg" disabled>
                <SelectTrigger aria-labelledby="disabled-unit-label">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kg">Kilograms (kg)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Section>
        </>
      );
    case 'card':
      return (
        <>
          <Section
            title="Related content"
            description="Illustrative training data. A soft fill groups the content without an extra shadow."
          >
            <Card className="sample-card">
              <CardHeader>
                <div className="specimen-row">
                  <Badge variant="secondary">Planned</Badge>
                  <span className="specimen-note">Illustrative preview</span>
                </div>
                <CardTitle>Upper body</CardTitle>
                <CardDescription>A focused strength session, with room to adjust.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="training-summary">
                  <div>
                    <span>Duration</span>
                    <strong>45 min</strong>
                  </div>
                  <div>
                    <span>Exercises</span>
                    <strong>5 planned</strong>
                  </div>
                  <div>
                    <span>Load</span>
                    <strong>Not recorded</strong>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <span className="specimen-note">Targets are not completed work.</span>
                <Button
                  size="sm"
                  onClick={() => setStatus('Sample session opened in this preview.')}
                >
                  View session <ArrowRight />
                </Button>
              </CardFooter>
            </Card>
            <Status>{status}</Status>
          </Section>
        </>
      );
    case 'separator':
      return (
        <>
          <Section title="Horizontal">
            <div className="specimen-stack">
              <strong>Session targets</strong>
              <Separator />
              <p className="specimen-note">Actual sets are recorded separately.</p>
            </div>
          </Section>
          <Section title="Vertical">
            <div className="separator-example">
              <span>Nutrition</span>
              <Separator orientation="vertical" />
              <span>Training</span>
              <Separator orientation="vertical" />
              <span>Recovery</span>
            </div>
          </Section>
        </>
      );
    case 'tabs':
      return (
        <>
          <Section
            title="Related views"
            description="Arrow keys move across tabs. Each view keeps its own labeled panel."
          >
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              <TabsList aria-label="Daily practice">
                <TabsTrigger value="training">Training</TabsTrigger>
                <TabsTrigger value="nutrition">Nutrition</TabsTrigger>
                <TabsTrigger value="recovery" disabled>
                  Recovery
                </TabsTrigger>
              </TabsList>
              <TabsContent value="training">
                <h3 className="preview-title">Your training, at a glance.</h3>
                <p className="specimen-note">
                  Illustrative plan: an upper-body session today. No completed sets recorded.
                </p>
              </TabsContent>
              <TabsContent value="nutrition">
                <h3 className="preview-title">Room for your next meal.</h3>
                <p className="specimen-note">
                  Illustrative plan: breakfast, lunch, and dinner. Planned meals are not food logs.
                </p>
              </TabsContent>
            </Tabs>
          </Section>
        </>
      );
    case 'accordion':
      return (
        <>
          <Section
            title="Supporting detail"
            description="Open more than one section when comparison helps."
          >
            <Accordion defaultValue={['planned']} multiple>
              <AccordionItem value="planned">
                <AccordionTrigger>What counts as planned activity?</AccordionTrigger>
                <AccordionContent>
                  A target describes what you intend to do. It stays separate from the sets, meals,
                  and measurements you actually record.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="estimate">
                <AccordionTrigger>How should I use a nutrition estimate?</AccordionTrigger>
                <AccordionContent>
                  Review the food, portion, and assumptions. Edit the draft before saving, and check
                  a product label when one is available.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="unavailable" disabled>
                <AccordionTrigger>Coaching guidance (unavailable)</AccordionTrigger>
                <AccordionContent>Coaching is outside this preview.</AccordionContent>
              </AccordionItem>
            </Accordion>
          </Section>
        </>
      );
    case 'table':
      return (
        <>
          <Section
            title="Recorded work"
            description="Illustrative completed sets. Quantities include units; the table can scroll on small screens."
          >
            <Table>
              <TableCaption>
                Sample session · dumbbell loads are per hand, not combined.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Exercise</TableHead>
                  <TableHead scope="col">Set</TableHead>
                  <TableHead scope="col" className="numeric">
                    Load / hand
                  </TableHead>
                  <TableHead scope="col" className="numeric">
                    Reps
                  </TableHead>
                  <TableHead scope="col">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[
                  { set: 1, load: '20 kg', reps: 10 },
                  { set: 2, load: '22.5 kg', reps: 8 },
                  { set: 3, load: '22.5 kg', reps: 8 },
                ].map((row) => (
                  <TableRow key={row.set}>
                    <TableCell>Dumbbell press</TableCell>
                    <TableCell>{row.set}</TableCell>
                    <TableCell className="numeric">{row.load}</TableCell>
                    <TableCell className="numeric">{row.reps}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        <Check size={12} />
                        Recorded
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Section>
        </>
      );
    case 'badge':
      return (
        <>
          <Section title="State, in a few words">
            <div className="specimen-row">
              <Badge>Active</Badge>
              <Badge variant="secondary">Planned</Badge>
              <Badge variant="outline">Draft</Badge>
              <Badge variant="destructive">Needs review</Badge>
              <Badge variant="ghost">Not recorded</Badge>
            </div>
          </Section>
          <Section
            title="With an icon"
            description="The label carries the meaning; the icon reinforces it."
          >
            <div className="specimen-row">
              <Badge variant="secondary">
                <Check size={12} />
                Recorded
              </Badge>
              <Badge variant="outline">
                <Info size={12} />
                Estimate
              </Badge>
            </div>
          </Section>
        </>
      );
    case 'alert':
      return (
        <>
          <Section
            title="Feedback with a next step"
            description="Illustrative messages only. Success and warning are Corner extensions to the upstream variants."
          >
            <div className="specimen-stack">
              <Alert>
                <Info />
                <AlertTitle>Nutrition is an estimate</AlertTitle>
                <AlertDescription>
                  Check portions and product labels before recording a meal.
                </AlertDescription>
              </Alert>
              <Alert variant="success">
                <CheckCircle2 />
                <AlertTitle>Sample updated</AlertTitle>
                <AlertDescription>
                  Your preview changes are visible here. No product data was saved.
                </AlertDescription>
              </Alert>
              <Alert variant="warning">
                <AlertCircle />
                <AlertTitle>Review this draft</AlertTitle>
                <AlertDescription>
                  Confirm the portion size before saving your food entry.
                </AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <AlertCircle />
                <AlertTitle>Couldn’t save the sample</AlertTitle>
                <AlertDescription>
                  This is an error-state specimen. In a real form, keep the user’s draft and offer
                  Retry.
                </AlertDescription>
              </Alert>
            </div>
          </Section>
        </>
      );
    case 'progress':
      return (
        <>
          <Section
            title="A named target"
            description="Illustrative session, with completed work separate from the plan."
          >
            <div className="specimen-narrow">
              <Progress value={progress} max={5}>
                <ProgressLabel>Exercises completed</ProgressLabel>
                <ProgressValue>{() => `${progress} / 5`}</ProgressValue>
              </Progress>
              <div className="specimen-row progress-actions">
                <Button
                  size="sm"
                  disabled={progress === 5}
                  onClick={() => setProgress((value) => Math.min(5, value + 1))}
                >
                  Complete next exercise
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setProgress(0)}>
                  Reset preview
                </Button>
              </div>
              <Status>
                {progress === 5
                  ? 'All five sample exercises are complete.'
                  : `${progress} of 5 sample exercises completed.`}
              </Status>
            </div>
          </Section>
          <Section title="Zero & complete">
            <div className="specimen-grid">
              <Progress value={0} aria-label="Not started" />
              <Progress value={100} aria-label="Complete" />
            </div>
          </Section>
        </>
      );
    case 'dialog':
      return (
        <>
          <Section
            title="Edit a session"
            description="The dialog contains a real local draft. Cancel discards edits; Save updates only this preview."
          >
            <div className="specimen-row">
              <Badge variant="outline">{name}</Badge>
              <Dialog
                open={open}
                onOpenChange={(next) => {
                  if (next) setDraft(name);
                  setOpen(next);
                }}
              >
                <DialogTrigger render={<Button variant="outline" />}>
                  Edit sample session
                </DialogTrigger>
                <DialogContent>
                  <DialogTitle>Edit session</DialogTitle>
                  <DialogDescription>
                    Give this sample a name. Changes stay in the catalog.
                  </DialogDescription>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      setName(draft.trim());
                      setOpen(false);
                      setStatus(`Preview updated: ${draft.trim()}.`);
                    }}
                  >
                    <Field label="Session name">
                      <Input
                        required
                        maxLength={120}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </Field>
                    <DialogFooter>
                      <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                      <Button type="submit" disabled={!draft.trim()}>
                        Save preview
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </div>
            <Status>{status}</Status>
          </Section>
        </>
      );
    case 'popover':
      return (
        <>
          <Section
            title="Contextual preferences"
            description="Settings apply immediately to the local preview. Escape or click outside to dismiss."
          >
            <Popover>
              <PopoverTrigger render={<Button variant="outline" />}>
                <Settings2 />
                Display settings
              </PopoverTrigger>
              <PopoverContent>
                <PopoverTitle>Display settings</PopoverTitle>
                <PopoverDescription>Adjust this sample’s detail level.</PopoverDescription>
                <label className="choice-label">
                  <Switch checked={enabled} onCheckedChange={setEnabled} />
                  <span>Show session notes</span>
                </label>
              </PopoverContent>
            </Popover>
            <Status>Session notes are {enabled ? 'visible' : 'hidden'} in this preview.</Status>
            {enabled && (
              <p className="sample-note">Sample note: keep the same targets next time.</p>
            )}
          </Section>
        </>
      );
    case 'dropdown-menu':
      return (
        <>
          <Section
            title="Session actions"
            description="Arrow keys navigate. Disabled items are skipped; Escape returns to the trigger."
          >
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" />}>
                Sample actions <ChevronMenu />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => setStatus('Sample duplicated in this preview.')}>
                  <Plus size={15} />
                  Duplicate sample
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setStatus('Sample moved to tomorrow in this preview.')}
                >
                  <ArrowRight size={15} />
                  Move to tomorrow
                </DropdownMenuItem>
                <DropdownMenuItem disabled>Share with a coach</DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setStatus('Sample removed from this preview.')}
                >
                  <Trash2 size={15} />
                  Remove sample
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Status>{status}</Status>
          </Section>
        </>
      );
    default:
      return null;
  }
}

const coreLookup: Record<string, true> = Object.fromEntries(
  coreCatalog.map((item) => [item.id, true]),
);

export function Specimen({ id }: { id: string }) {
  return coreLookup[id] ? <CoreSpecimen id={id} /> : <ExpandedSpecimen id={id} />;
}
function ChevronMenu() {
  return <Settings2 size={16} />;
}
