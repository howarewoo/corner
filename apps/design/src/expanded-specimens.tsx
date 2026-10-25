import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as UI from '@packages/ui';
import { ArrowRight, Bookmark, Check, Dumbbell, Info, Plus, Search, Settings2 } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { DataTableSpecimen } from './table-specimen';
import { ConversationSpecimen } from './conversation-specimens';
import { catalogHref } from './catalog';
import { CatalogThemeContext } from './catalog-theme';

// Compositions sourced from the live shadcn Base UI documentation on 2026-10-23.
// Each ID maps to https://ui.shadcn.com/docs/components/base/<id>.
// Native Form composition follows https://ui.shadcn.com/docs/forms and Field.
const exercises = ['Dumbbell press', 'Goblet squat', 'Romanian deadlift', 'Seated row'];
const sampleChart = [
  { day: 'Mon', planned: 5, recorded: 4 },
  { day: 'Tue', planned: 3, recorded: 3 },
  { day: 'Wed', planned: 5, recorded: 5 },
  { day: 'Thu', planned: 4, recorded: 2 },
  { day: 'Fri', planned: 3, recorded: 3 },
];
const chartConfig = {
  planned: { label: 'Planned', color: 'var(--chart-2)' },
  recorded: { label: 'Recorded', color: 'var(--chart-1)' },
} satisfies UI.ChartConfig;
const sampleAvatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="40" fill="#d9e8de"/><text x="40" y="49" font-family="Arial,sans-serif" font-size="26" text-anchor="middle" fill="#234b35">CW</text></svg>')}`;

const sidebarDestinations = [
  { id: 'overview', label: 'Overview', icon: <Dumbbell size={18} /> },
  { id: 'sessions', label: 'Sessions', icon: <Bookmark size={18} /> },
  { id: 'preferences', label: 'Preferences', icon: <Settings2 size={18} /> },
];

function SidebarSpecimenContent() {
  const sidebar = UI.useSidebar();
  const theme = useContext(CatalogThemeContext);
  const [selected, setSelected] = useState('overview');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const selectedFromDrawer = useRef(false);
  useEffect(() => {
    if (sidebar.openMobile) selectedFromDrawer.current = false;
  }, [sidebar.openMobile]);
  const destination = sidebarDestinations.find((item) => item.id === selected)!;
  const matches = sidebarDestinations.filter((item) =>
    item.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  function select(id: string) {
    setSelected(id);
    if (sidebar.isMobile) {
      selectedFromDrawer.current = true;
      sidebar.setOpenMobile(false);
    } else {
      heading.current?.focus();
    }
  }
  return (
    <>
      <UI.AppSidebar
        id="specimen-navigation"
        label="Sample workspace navigation"
        brand={{ id: 'overview', label: 'Sample workspace home' }}
        caption="Illustrative workspace"
        groups={[{ label: 'Workspace', items: matches }]}
        selectedId={selected}
        selectedIndicator
        onSelect={select}
        search={{
          value: query,
          onChange: setQuery,
          label: 'Search sample destinations',
          placeholder: 'Search destinations…',
          inputRef: search,
        }}
        empty={{
          message: 'No sample destinations match.',
          actionLabel: 'Clear search',
          onAction: () => {
            setQuery('');
            search.current?.focus();
          },
        }}
        theme={theme}
        profile={{
          name: 'Sample member',
          initial: 'SM',
          label: 'Open sample preferences',
          selected: selected === 'preferences',
          onSelect: () => select('preferences'),
        }}
        note="Local specimen only. No product navigation or data."
        mobileContentProps={{
          initialFocus: () => search.current,
          finalFocus: () => (selectedFromDrawer.current ? heading.current : trigger.current),
        }}
      />
      <UI.SidebarInset className="sidebar-specimen-content">
        <div className="specimen-row">
          <UI.SidebarTrigger ref={trigger} aria-label="Toggle sample workspace navigation" />
          <UI.Button variant="outline" onClick={sidebar.toggleSidebar}>
            Toggle the sample sidebar
          </UI.Button>
        </div>
        <h3 ref={heading} tabIndex={-1}>
          {destination.label}
        </h3>
        <p>
          This self-contained workspace uses the real shared AppSidebar, SidebarProvider,
          SidebarInset, and SidebarTrigger. Its destinations do not navigate Storybook.
        </p>
        <p className="specimen-note" role="status">
          Selected: {destination.label}. Desktop: {sidebar.open ? 'expanded' : 'collapsed'}. On
          phones, open the real Sheet, search, choose a destination, or close it to return focus to
          the trigger.
        </p>
      </UI.SidebarInset>
    </>
  );
}

function SidebarSpecimen() {
  return (
    <UI.SidebarProvider className="sidebar-specimen">
      <SidebarSpecimenContent />
    </UI.SidebarProvider>
  );
}

export function ExpandedSpecimen({ id }: { id: string }) {
  const [status, setStatus] = useState('Illustrative preview. Changes stay in this catalog.');
  const [enabled, setEnabled] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [value, setValue] = useState(id === 'drawer' ? '45' : '');
  const [choice, setChoice] = useState<string | null>(null);
  const [date, setDate] = useState<Date | undefined>(new Date(2026, 9, 23));
  const [page, setPage] = useState(1);
  const [slider, setSlider] = useState([60]);
  const [marks, setMarks] = useState<string[]>(['strength']);
  const [ratio, setRatio] = useState(16 / 9);
  let example: ReactNode;

  switch (id) {
    case 'alert-dialog':
      example = (
        <UI.AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
          <UI.AlertDialogTrigger render={<UI.Button variant="destructive" />}>
            Remove sample plan
          </UI.AlertDialogTrigger>
          <UI.AlertDialogContent>
            <UI.AlertDialogHeader>
              <UI.AlertDialogTitle>Remove this sample plan?</UI.AlertDialogTitle>
              <UI.AlertDialogDescription>
                This only changes the local preview. No Corner data is affected.
              </UI.AlertDialogDescription>
            </UI.AlertDialogHeader>
            <UI.AlertDialogFooter>
              <UI.AlertDialogCancel>Keep sample</UI.AlertDialogCancel>
              <UI.AlertDialogAction
                onClick={() => {
                  setStatus('The sample plan was removed from this preview.');
                  setConfirmationOpen(false);
                }}
              >
                Remove sample
              </UI.AlertDialogAction>
            </UI.AlertDialogFooter>
          </UI.AlertDialogContent>
        </UI.AlertDialog>
      );
      break;
    case 'aspect-ratio':
      example = (
        <div className="specimen-stack">
          <div className="specimen-row">
            <UI.Button
              size="sm"
              variant={ratio === 16 / 9 ? 'default' : 'outline'}
              onClick={() => setRatio(16 / 9)}
            >
              16:9
            </UI.Button>
            <UI.Button
              size="sm"
              variant={ratio === 1 ? 'default' : 'outline'}
              onClick={() => setRatio(1)}
            >
              Square
            </UI.Button>
          </div>
          <UI.AspectRatio ratio={ratio} className="max-w-md rounded-xl bg-secondary">
            <div className="flex h-full items-center justify-center gap-3">
              <Dumbbell />
              <span>Training preview · {ratio === 1 ? '1:1' : '16:9'}</span>
            </div>
          </UI.AspectRatio>
        </div>
      );
      break;
    case 'avatar':
      example = (
        <div className="specimen-row">
          <UI.Avatar size="lg">
            <UI.AvatarImage src={sampleAvatar} alt="Sample member CW" />
            <UI.AvatarFallback>CW</UI.AvatarFallback>
            <UI.AvatarBadge>
              <Check size={10} />
            </UI.AvatarBadge>
          </UI.Avatar>
          <UI.Avatar>
            <UI.AvatarImage src="data:image/png,unavailable" alt="Unavailable sample avatar" />
            <UI.AvatarFallback>AL</UI.AvatarFallback>
          </UI.Avatar>
          <UI.AvatarGroup>
            <UI.Avatar>
              <UI.AvatarFallback>CW</UI.AvatarFallback>
            </UI.Avatar>
            <UI.Avatar>
              <UI.AvatarFallback>AL</UI.AvatarFallback>
            </UI.Avatar>
            <UI.AvatarGroupCount>+2</UI.AvatarGroupCount>
          </UI.AvatarGroup>
        </div>
      );
      break;
    case 'breadcrumb':
      example = (
        <UI.Breadcrumb>
          <UI.BreadcrumbList>
            <UI.BreadcrumbItem>
              <UI.BreadcrumbLink render={<a href={catalogHref('colors')} target="_top" />}>
                Design
              </UI.BreadcrumbLink>
            </UI.BreadcrumbItem>
            <UI.BreadcrumbSeparator />
            <UI.BreadcrumbItem>
              <UI.BreadcrumbLink render={<a href={catalogHref('sidebar')} target="_top" />}>
                Navigation
              </UI.BreadcrumbLink>
            </UI.BreadcrumbItem>
            <UI.BreadcrumbSeparator />
            <UI.BreadcrumbItem>
              <UI.BreadcrumbPage>Breadcrumb</UI.BreadcrumbPage>
            </UI.BreadcrumbItem>
          </UI.BreadcrumbList>
        </UI.Breadcrumb>
      );
      break;
    case 'button-group':
      example = (
        <UI.ButtonGroup>
          <UI.Button variant="outline" onClick={() => setStatus('Sample session duplicated.')}>
            Duplicate
          </UI.Button>
          <UI.Button
            variant="outline"
            onClick={() => setStatus('Sample session moved to tomorrow.')}
          >
            Move
          </UI.Button>
          <UI.Button
            variant="outline"
            size="icon"
            aria-label="Add sample session"
            onClick={() => setStatus('A session was added to this preview.')}
          >
            <Plus />
          </UI.Button>
        </UI.ButtonGroup>
      );
      break;
    case 'calendar':
      example = (
        <div className="specimen-stack">
          <UI.Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            defaultMonth={new Date(2026, 9, 1)}
            className="w-fit rounded-xl"
            captionLayout="dropdown"
          />
          <p className="specimen-note">
            Selected: {date?.toLocaleDateString('en-US', { dateStyle: 'long' }) ?? 'No date'}.
          </p>
        </div>
      );
      break;
    case 'carousel':
      example = (
        <UI.Carousel className="catalog-carousel" opts={{ loop: false }}>
          <UI.CarouselContent>
            {['Strength', 'Conditioning', 'Recovery'].map((title, index) => (
              <UI.CarouselItem key={title}>
                <div className="carousel-slide">
                  <UI.Badge variant="secondary">Illustrative session {index + 1}</UI.Badge>
                  <h3>{title}</h3>
                  <p>A different focus for your everyday practice.</p>
                </div>
              </UI.CarouselItem>
            ))}
          </UI.CarouselContent>
          <UI.CarouselPrevious />
          <UI.CarouselNext />
        </UI.Carousel>
      );
      break;
    case 'chart':
      example = (
        <div className="specimen-stack">
          <div className="specimen-row">
            <UI.Button
              size="sm"
              variant={!enabled ? 'default' : 'outline'}
              onClick={() => setEnabled(false)}
            >
              Planned & recorded
            </UI.Button>
            <UI.Button
              size="sm"
              variant={enabled ? 'default' : 'outline'}
              onClick={() => setEnabled(true)}
            >
              Recorded only
            </UI.Button>
          </div>
          <UI.ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart accessibilityLayer data={sampleChart}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={25} />
              <UI.ChartTooltip content={<UI.ChartTooltipContent />} />
              {!enabled && <Bar dataKey="planned" fill="var(--color-planned)" radius={4} />}
              <Bar dataKey="recorded" fill="var(--color-recorded)" radius={4} />
            </BarChart>
          </UI.ChartContainer>
          <p className="specimen-note">
            Illustrative exercise counts. Planned work is not completed work.
          </p>
        </div>
      );
      break;
    case 'collapsible':
      example = (
        <UI.Collapsible open={enabled} onOpenChange={setEnabled} className="specimen-stack">
          <UI.CollapsibleTrigger render={<UI.Button variant="outline" />}>
            {enabled ? 'Hide' : 'Show'} session details
          </UI.CollapsibleTrigger>
          <UI.CollapsibleContent>
            <p>Five planned exercises · 45 minutes · actual work not recorded.</p>
          </UI.CollapsibleContent>
        </UI.Collapsible>
      );
      break;
    case 'combobox':
      example = (
        <div className="specimen-narrow">
          <label className="specimen-label" id="exercise-combo-label">
            Find an exercise
          </label>
          <UI.Combobox items={exercises} value={choice} onValueChange={setChoice}>
            <UI.ComboboxInput
              aria-labelledby="exercise-combo-label"
              placeholder="Search exercises…"
            />
            <UI.ComboboxContent>
              <UI.ComboboxEmpty>No exercises match.</UI.ComboboxEmpty>
              <UI.ComboboxList>
                {(item) => (
                  <UI.ComboboxItem key={item} value={item}>
                    {item}
                  </UI.ComboboxItem>
                )}
              </UI.ComboboxList>
            </UI.ComboboxContent>
          </UI.Combobox>
          <p className="specimen-status">Selected: {choice ?? 'None'}.</p>
        </div>
      );
      break;
    case 'command':
      example = (
        <UI.Command className="max-w-md rounded-xl">
          <UI.CommandInput
            placeholder="Find a preview action…"
            aria-label="Search preview actions"
          />
          <UI.CommandList>
            <UI.CommandEmpty>No matching actions.</UI.CommandEmpty>
            <UI.CommandGroup heading="Preview actions">
              <UI.CommandItem onSelect={() => setStatus('Sample session added.')}>
                <Plus />
                Add sample session
              </UI.CommandItem>
              <UI.CommandItem onSelect={() => setStatus('Sample preferences opened.')}>
                <Settings2 />
                Open preferences
              </UI.CommandItem>
              <UI.CommandItem disabled>Share with a coach</UI.CommandItem>
            </UI.CommandGroup>
          </UI.CommandList>
        </UI.Command>
      );
      break;
    case 'context-menu':
      example = (
        <UI.ContextMenu>
          <UI.ContextMenuTrigger className="context-target" tabIndex={0}>
            Right click or long press this sample session.
          </UI.ContextMenuTrigger>
          <UI.ContextMenuContent>
            <UI.ContextMenuItem onClick={() => setStatus('Sample session duplicated.')}>
              Duplicate sample
            </UI.ContextMenuItem>
            <UI.ContextMenuItem onClick={() => setStatus('Sample moved to tomorrow.')}>
              Move to tomorrow
            </UI.ContextMenuItem>
            <UI.ContextMenuItem disabled>Share with a coach</UI.ContextMenuItem>
          </UI.ContextMenuContent>
        </UI.ContextMenu>
      );
      break;
    case 'data-table':
      return <DataTableSpecimen />;
    case 'date-picker':
      example = (
        <UI.Popover>
          <UI.PopoverTrigger render={<UI.Button variant="outline" />}>
            {date ? date.toLocaleDateString('en-US', { dateStyle: 'long' }) : 'Pick a date'}
          </UI.PopoverTrigger>
          <UI.PopoverContent className="date-picker-popup">
            <UI.Calendar mode="single" selected={date} onSelect={setDate} defaultMonth={date} />
          </UI.PopoverContent>
        </UI.Popover>
      );
      break;
    case 'direction':
      example = (
        <div className="specimen-stack">
          <UI.Button variant="outline" onClick={() => setEnabled(!enabled)}>
            Use {enabled ? 'left-to-right' : 'right-to-left'}
          </UI.Button>
          <UI.DirectionProvider direction={enabled ? 'rtl' : 'ltr'}>
            <div dir={enabled ? 'rtl' : 'ltr'} className="direction-preview">
              <UI.Breadcrumb>
                <UI.BreadcrumbList>
                  <UI.BreadcrumbItem>
                    <UI.BreadcrumbPage>{enabled ? 'التدريب' : 'Training'}</UI.BreadcrumbPage>
                  </UI.BreadcrumbItem>
                  <UI.BreadcrumbSeparator />
                  <UI.BreadcrumbItem>
                    <UI.BreadcrumbPage>{enabled ? 'اليوم' : 'Today'}</UI.BreadcrumbPage>
                  </UI.BreadcrumbItem>
                </UI.BreadcrumbList>
              </UI.Breadcrumb>
              <UI.Input
                aria-label="Sample session name"
                placeholder={enabled ? 'اسم الجلسة' : 'Session name'}
              />
            </div>
          </UI.DirectionProvider>
        </div>
      );
      break;
    case 'drawer':
      example = (
        <UI.Drawer>
          <UI.DrawerTrigger render={<UI.Button variant="outline" />}>
            Adjust sample duration
          </UI.DrawerTrigger>
          <UI.DrawerContent>
            <UI.DrawerHeader>
              <UI.DrawerTitle>Session duration</UI.DrawerTitle>
              <UI.DrawerDescription>
                Choose 5–180 minutes for this illustrative target, not a recorded result.
              </UI.DrawerDescription>
            </UI.DrawerHeader>
            <div className="px-6 pb-4">
              <label className="specimen-label" htmlFor="drawer-duration">
                Minutes
              </label>
              <UI.Input
                id="drawer-duration"
                type="number"
                min={5}
                max={180}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <UI.DrawerFooter>
              <UI.DrawerClose
                render={
                  <UI.Button
                    disabled={
                      !value ||
                      !Number.isFinite(Number(value)) ||
                      Number(value) < 5 ||
                      Number(value) > 180
                    }
                    onClick={() => setStatus(`Sample duration: ${value} minutes.`)}
                  />
                }
              >
                Use duration
              </UI.DrawerClose>
              <UI.DrawerClose render={<UI.Button variant="outline" />}>Cancel</UI.DrawerClose>
            </UI.DrawerFooter>
          </UI.DrawerContent>
        </UI.Drawer>
      );
      break;
    case 'empty':
      example = (
        <UI.Empty>
          <UI.EmptyHeader>
            <UI.EmptyMedia variant="icon">
              <Dumbbell />
            </UI.EmptyMedia>
            <UI.EmptyTitle>{enabled ? 'One sample session' : 'No sessions planned'}</UI.EmptyTitle>
            <UI.EmptyDescription>
              {enabled
                ? 'Your preview now contains an illustrative session.'
                : 'Start with a session that fits the time you have.'}
            </UI.EmptyDescription>
          </UI.EmptyHeader>
          <UI.EmptyContent>
            <UI.Button
              onClick={() => {
                setEnabled(!enabled);
                setStatus(enabled ? 'Sample cleared.' : 'Sample session added.');
              }}
            >
              {enabled ? 'Clear preview' : 'Add sample session'}
            </UI.Button>
          </UI.EmptyContent>
        </UI.Empty>
      );
      break;
    case 'field':
      example = (
        <UI.FieldGroup className="max-w-md">
          <UI.Field data-invalid={value.length > 0 && value.length < 3}>
            <UI.FieldLabel htmlFor="field-session">Session name</UI.FieldLabel>
            <UI.Input
              id="field-session"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-describedby="field-help field-error"
              aria-invalid={value.length > 0 && value.length < 3}
              placeholder="e.g. Upper body"
            />
            <UI.FieldDescription id="field-help">
              Use at least three characters.
            </UI.FieldDescription>
            {value.length > 0 && value.length < 3 && (
              <UI.FieldError id="field-error">Add at least three characters.</UI.FieldError>
            )}
          </UI.Field>
        </UI.FieldGroup>
      );
      break;
    case 'form':
      example = (
        <form
          className="specimen-stack max-w-md"
          onSubmit={(event) => {
            event.preventDefault();
            setStatus(`Preview form submitted: ${value.trim()}.`);
          }}
        >
          <UI.Field>
            <UI.FieldLabel htmlFor="form-name">Sample session name</UI.FieldLabel>
            <UI.Input
              id="form-name"
              required
              minLength={3}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Name the session"
            />
            <UI.FieldDescription>
              The browser validates this form. Nothing is sent to a server.
            </UI.FieldDescription>
          </UI.Field>
          <div className="specimen-row">
            <UI.Button type="submit">Submit preview</UI.Button>
            <UI.Button
              variant="outline"
              type="button"
              onClick={() => {
                setValue('');
                setStatus('Preview form reset.');
              }}
            >
              Reset
            </UI.Button>
          </div>
        </form>
      );
      break;
    case 'hover-card':
      example = (
        <UI.HoverCard>
          <UI.HoverCardTrigger render={<UI.Button variant="link" />}>
            About this sample
          </UI.HoverCardTrigger>
          <UI.HoverCardContent>
            <h3 className="font-semibold">Upper body</h3>
            <p>Five planned exercises. No completed work is recorded by this preview.</p>
          </UI.HoverCardContent>
        </UI.HoverCard>
      );
      break;
    case 'input-group':
      example = (
        <UI.InputGroup className="max-w-md">
          <UI.InputGroupInput
            aria-label="Search sample sessions"
            placeholder="Search sample sessions…"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <UI.InputGroupAddon>
            <Search />
          </UI.InputGroupAddon>
          <UI.InputGroupAddon align="inline-end">
            <UI.InputGroupButton
              aria-label="Run sample search"
              onClick={() =>
                setStatus(
                  value ? `Searching preview for “${value}”.` : 'Enter a session name to search.',
                )
              }
            >
              <ArrowRight />
            </UI.InputGroupButton>
          </UI.InputGroupAddon>
        </UI.InputGroup>
      );
      break;
    case 'input-otp':
      example = (
        <div className="specimen-stack">
          <label htmlFor="sample-otp" className="specimen-label">
            Illustrative six-digit code
          </label>
          <UI.InputOTP id="sample-otp" maxLength={6} value={value} onChange={setValue}>
            <UI.InputOTPGroup>
              {Array.from({ length: 6 }, (_, index) => (
                <UI.InputOTPSlot key={index} index={index} />
              ))}
            </UI.InputOTPGroup>
          </UI.InputOTP>
          <p className="specimen-note">
            {value.length === 6
              ? 'Six digits entered. This is not a real verification request.'
              : `${value.length} of 6 digits entered.`}
          </p>
        </div>
      );
      break;
    case 'item':
      example = (
        <UI.Item variant="muted">
          <UI.ItemMedia variant="icon">
            <Dumbbell />
          </UI.ItemMedia>
          <UI.ItemContent>
            <UI.ItemTitle>Upper body</UI.ItemTitle>
            <UI.ItemDescription>45 minutes · illustrative plan</UI.ItemDescription>
          </UI.ItemContent>
          <UI.ItemActions>
            <UI.Button
              size="sm"
              variant="outline"
              onClick={() => setStatus('Sample session opened.')}
            >
              View
            </UI.Button>
          </UI.ItemActions>
        </UI.Item>
      );
      break;
    case 'kbd':
      example = (
        <div className="specimen-stack">
          <p>
            Illustrative find action{' '}
            <UI.KbdGroup>
              <UI.Kbd>⌘ / Ctrl</UI.Kbd>
              <UI.Kbd>K</UI.Kbd>
            </UI.KbdGroup>
          </p>
          <p>
            Illustrative sidebar action{' '}
            <UI.KbdGroup>
              <UI.Kbd>⌘ / Ctrl</UI.Kbd>
              <UI.Kbd>B</UI.Kbd>
            </UI.KbdGroup>
          </p>
          <p className="specimen-note">
            Keycap presentation only; these examples do not register shortcuts.
          </p>
        </div>
      );
      break;
    case 'label':
      example = (
        <div className="specimen-row">
          <UI.Checkbox id="label-sample" checked={enabled} onCheckedChange={setEnabled} />
          <UI.Label htmlFor="label-sample">Include a warm-up</UI.Label>
          <span className="specimen-note">{enabled ? 'Included' : 'Not included'}</span>
        </div>
      );
      break;
    case 'menubar':
      example = (
        <UI.Menubar>
          <UI.MenubarMenu>
            <UI.MenubarTrigger>Session</UI.MenubarTrigger>
            <UI.MenubarContent>
              <UI.MenubarItem onClick={() => setStatus('Sample session created.')}>
                New sample
              </UI.MenubarItem>
              <UI.MenubarItem onClick={() => setStatus('Sample session duplicated.')}>
                Duplicate
              </UI.MenubarItem>
              <UI.MenubarItem disabled>Share with coach</UI.MenubarItem>
            </UI.MenubarContent>
          </UI.MenubarMenu>
          <UI.MenubarMenu>
            <UI.MenubarTrigger>View</UI.MenubarTrigger>
            <UI.MenubarContent>
              <UI.MenubarCheckboxItem checked={enabled} onCheckedChange={setEnabled}>
                Show sample notes
              </UI.MenubarCheckboxItem>
            </UI.MenubarContent>
          </UI.MenubarMenu>
        </UI.Menubar>
      );
      break;
    case 'native-select':
      example = (
        <UI.Field className="max-w-sm">
          <UI.FieldLabel htmlFor="native-session">Training focus</UI.FieldLabel>
          <UI.NativeSelect
            id="native-session"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          >
            <UI.NativeSelectOption value="">Choose a focus</UI.NativeSelectOption>
            <UI.NativeSelectOption value="Strength">Strength</UI.NativeSelectOption>
            <UI.NativeSelectOption value="Conditioning">Conditioning</UI.NativeSelectOption>
            <UI.NativeSelectOption disabled>Coached (unavailable)</UI.NativeSelectOption>
          </UI.NativeSelect>
          <UI.FieldDescription>Selected: {value || 'None'}.</UI.FieldDescription>
        </UI.Field>
      );
      break;
    case 'navigation-menu':
      example = (
        <UI.NavigationMenu>
          <UI.NavigationMenuList>
            <UI.NavigationMenuItem>
              <UI.NavigationMenuTrigger>Foundations</UI.NavigationMenuTrigger>
              <UI.NavigationMenuContent>
                <div className="grid w-56 gap-2 p-3">
                  <UI.NavigationMenuLink href={catalogHref('colors')} target="_top">
                    Colors
                  </UI.NavigationMenuLink>
                  <UI.NavigationMenuLink href={catalogHref('typography')} target="_top">
                    Typography
                  </UI.NavigationMenuLink>
                  <UI.NavigationMenuLink href={catalogHref('spacing')} target="_top">
                    Spacing & shape
                  </UI.NavigationMenuLink>
                </div>
              </UI.NavigationMenuContent>
            </UI.NavigationMenuItem>
            <UI.NavigationMenuItem>
              <UI.NavigationMenuLink
                href={catalogHref('sidebar')}
                target="_top"
                className={UI.navigationMenuTriggerStyle()}
              >
                Sidebar
              </UI.NavigationMenuLink>
            </UI.NavigationMenuItem>
          </UI.NavigationMenuList>
        </UI.NavigationMenu>
      );
      break;
    case 'pagination':
      example = (
        <div className="specimen-stack">
          <UI.Pagination>
            <UI.PaginationContent>
              <UI.PaginationItem>
                <UI.PaginationPrevious
                  href={`${catalogHref('pagination')}&page=${Math.max(1, page - 1)}`}
                  target="_top"
                  onClick={(event) => {
                    event.preventDefault();
                    setPage(Math.max(1, page - 1));
                  }}
                  aria-disabled={page === 1}
                />
              </UI.PaginationItem>
              {[1, 2, 3].map((number) => (
                <UI.PaginationItem key={number}>
                  <UI.PaginationLink
                    href={`${catalogHref('pagination')}&page=${number}`}
                    target="_top"
                    isActive={number === page}
                    onClick={(event) => {
                      event.preventDefault();
                      setPage(number);
                    }}
                  >
                    {number}
                  </UI.PaginationLink>
                </UI.PaginationItem>
              ))}
              <UI.PaginationItem>
                <UI.PaginationNext
                  href={`${catalogHref('pagination')}&page=${Math.min(3, page + 1)}`}
                  target="_top"
                  onClick={(event) => {
                    event.preventDefault();
                    setPage(Math.min(3, page + 1));
                  }}
                  aria-disabled={page === 3}
                />
              </UI.PaginationItem>
            </UI.PaginationContent>
          </UI.Pagination>
          <p className="specimen-note">
            Sample page {page} of 3:{' '}
            {['Strength sessions', 'Conditioning sessions', 'Recovery sessions'][page - 1]}.
          </p>
        </div>
      );
      break;
    case 'resizable':
      example = (
        <UI.ResizablePanelGroup orientation="horizontal" className="resizable-preview">
          <UI.ResizablePanel defaultSize="50%" minSize="20%">
            <div className="resizable-content">Session list</div>
          </UI.ResizablePanel>
          <UI.ResizableHandle withHandle aria-label="Resize sample panels" />
          <UI.ResizablePanel defaultSize="50%" minSize="20%">
            <div className="resizable-content">Session details</div>
          </UI.ResizablePanel>
        </UI.ResizablePanelGroup>
      );
      break;
    case 'scroll-area':
      example = (
        <UI.ScrollArea className="h-64 w-full max-w-sm rounded-xl bg-background">
          <div className="p-5">
            <h3 className="mb-4 font-semibold">Sample exercise list</h3>
            {Array.from({ length: 20 }, (_, index) => (
              <div key={index}>
                <p className="py-3 text-sm">
                  {index + 1}. {exercises[index % exercises.length]}
                </p>
                <UI.Separator />
              </div>
            ))}
          </div>
        </UI.ScrollArea>
      );
      break;
    case 'sheet':
      example = (
        <UI.Sheet>
          <UI.SheetTrigger render={<UI.Button variant="outline" />}>
            Open sample notes
          </UI.SheetTrigger>
          <UI.SheetContent>
            <UI.SheetHeader>
              <UI.SheetTitle>Session notes</UI.SheetTitle>
              <UI.SheetDescription>This panel edits only the sample preview.</UI.SheetDescription>
            </UI.SheetHeader>
            <div className="px-5">
              <UI.Label htmlFor="sheet-notes">Notes</UI.Label>
              <UI.Textarea
                id="sheet-notes"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </div>
            <UI.SheetFooter>
              <UI.SheetClose
                render={
                  <UI.Button
                    onClick={() =>
                      setStatus(value ? `Preview note: ${value}` : 'No sample notes entered.')
                    }
                  />
                }
              >
                Use sample notes
              </UI.SheetClose>
              <UI.SheetClose render={<UI.Button variant="outline" />}>Close</UI.SheetClose>
            </UI.SheetFooter>
          </UI.SheetContent>
        </UI.Sheet>
      );
      break;
    case 'sidebar':
      example = <SidebarSpecimen />;
      break;
    case 'skeleton':
      example = (
        <div className="flex max-w-md items-center gap-4" aria-label="Illustrative loading layout">
          <UI.Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="w-full space-y-3">
            <UI.Skeleton className="h-4 w-full" />
            <UI.Skeleton className="h-4 w-3/4" />
            <UI.Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      );
      break;
    case 'slider':
      example = (
        <div className="specimen-stack max-w-md">
          <label className="specimen-label" id="effort-label">
            Illustrative effort target: {slider[0]}%
          </label>
          <UI.Slider
            aria-labelledby="effort-label"
            value={slider}
            onValueChange={(next) => setSlider(Array.isArray(next) ? next : [next])}
            max={100}
            step={5}
          />
          <p id="unavailable-effort" className="specimen-label">
            Unavailable effort target
          </p>
          <UI.Slider aria-labelledby="unavailable-effort" defaultValue={[40]} disabled />
        </div>
      );
      break;
    case 'spinner':
      example = (
        <div className="specimen-row" role="status">
          <UI.Spinner />
          <span>Loading-state specimen · no request is running</span>
          <UI.Button disabled>
            <UI.Spinner />
            Loading…
          </UI.Button>
        </div>
      );
      break;
    case 'toast':
      example = (
        <UI.Button
          variant="outline"
          onClick={() => {
            const toastId = UI.toast.add({
              title: 'Sample session updated',
              description: 'No product data was saved.',
              actionProps: {
                children: 'Undo',
                onClick: () => {
                  setStatus('Sample change undone.');
                  UI.toast.close(toastId);
                },
              },
            });
          }}
        >
          Show Base UI toast
        </UI.Button>
      );
      break;
    case 'toggle':
      example = (
        <div className="specimen-row">
          <UI.Toggle
            pressed={enabled}
            onPressedChange={setEnabled}
            aria-label="Bookmark sample session"
          >
            <Bookmark />
            {enabled ? 'Bookmarked' : 'Bookmark'}
          </UI.Toggle>
          <UI.Toggle disabled aria-label="Unavailable bookmark">
            <Bookmark />
            Unavailable
          </UI.Toggle>
        </div>
      );
      break;
    case 'toggle-group':
      example = (
        <div className="specimen-stack">
          <UI.ToggleGroup
            multiple
            value={marks}
            onValueChange={setMarks}
            variant="outline"
            aria-label="Sample training filters"
          >
            <UI.ToggleGroupItem value="strength">Strength</UI.ToggleGroupItem>
            <UI.ToggleGroupItem value="conditioning">Conditioning</UI.ToggleGroupItem>
            <UI.ToggleGroupItem value="coached" disabled>
              Coached
            </UI.ToggleGroupItem>
          </UI.ToggleGroup>
          <p className="specimen-note">Selected: {marks.join(', ') || 'None'}.</p>
        </div>
      );
      break;
    case 'tooltip':
      example = (
        <UI.Tooltip>
          <UI.TooltipTrigger
            render={<UI.Button variant="outline" aria-label="Inspect sample session" />}
          >
            <Info />
            Inspect sample
          </UI.TooltipTrigger>
          <UI.TooltipContent>Sample only. No product data is changed.</UI.TooltipContent>
        </UI.Tooltip>
      );
      break;
    case 'attachment':
    case 'bubble':
    case 'code-block':
    case 'marker':
    case 'message':
    case 'message-scroller':
    case 'questionnaire':
    case 'trace':
      return <ConversationSpecimen id={id} />;
    default:
      return null;
  }
  return (
    <section className="specimen-section">
      <div className="specimen-heading">
        <h2>Live preview</h2>
        <p>Project-owned composition using the real shared control.</p>
      </div>
      <div className="specimen-preview">
        {example}
        <p className="specimen-status" role="status">
          {status}
        </p>
      </div>
    </section>
  );
}
