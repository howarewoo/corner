import type { ComponentProps } from 'react';
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { Input as InputPrimitive } from '@base-ui/react/input';
import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { Accordion as AccordionPrimitive } from '@base-ui/react/accordion';
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { Separator as SeparatorPrimitive } from '@base-ui/react/separator';
import { Check, ChevronDown, X } from 'lucide-react';
import { cva } from 'class-variance-authority';

// Adapted from the current shadcn base-nova registry; see ../NOTICE and ../provenance.json.
type Styled<T> = Omit<T, 'className'> & { className?: string };
const classes = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base);
type Variant = 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'link';
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-[14px] text-sm font-semibold',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        outline: 'border border-border bg-transparent text-foreground',
        ghost: 'bg-transparent text-foreground hover:bg-accent',
        destructive: 'bg-destructive/10 text-destructive',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 px-4',
        xs: 'h-7 px-2 text-xs',
        sm: 'h-9 px-3 text-xs',
        lg: 'h-12 px-5',
        icon: 'size-11',
        'icon-xs': 'size-7',
        'icon-sm': 'size-9',
        'icon-lg': 'size-12',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: Styled<ComponentProps<typeof ButtonPrimitive>> & {
  variant?: Variant;
  size?: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
}) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={classes(`ui-button ${buttonVariants({ variant, size })}`, className)}
      {...props}
    />
  );
}
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <InputPrimitive data-slot="input" className={classes('ui-input', className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={classes('ui-textarea', className)} {...props} />;
}
export function Checkbox({
  className,
  ...props
}: Styled<ComponentProps<typeof CheckboxPrimitive.Root>>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={classes('ui-checkbox', className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="ui-checkbox-indicator">
        <Check size={14} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
export function Switch({
  className,
  ...props
}: Styled<ComponentProps<typeof SwitchPrimitive.Root>>) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={classes('ui-switch', className)} {...props}>
      <SwitchPrimitive.Thumb className="ui-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
export function RadioGroup({
  className,
  ...props
}: Styled<ComponentProps<typeof RadioGroupPrimitive>>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={classes('ui-radio-group', className)}
      {...props}
    />
  );
}
export function RadioGroupItem({
  className,
  ...props
}: Styled<ComponentProps<typeof RadioPrimitive.Root>>) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={classes('ui-radio', className)}
      {...props}
    >
      <RadioPrimitive.Indicator className="ui-radio-indicator" />
    </RadioPrimitive.Root>
  );
}

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export function SelectTrigger({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof SelectPrimitive.Trigger>>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={classes('ui-select-trigger', className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon>
        <ChevronDown size={16} />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}
export function SelectContent({
  className,
  children,
  sideOffset = 6,
  align = 'start',
  ...props
}: Styled<ComponentProps<typeof SelectPrimitive.Popup>> &
  Pick<SelectPrimitive.Positioner.Props, 'sideOffset' | 'align'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        className="ui-positioner"
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={false}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={classes('ui-select-content', className)}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className="ui-scroll-arrow">
            Scroll up
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className="ui-scroll-arrow">
            Scroll down
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}
export function SelectItem({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof SelectPrimitive.Item>>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={classes('ui-select-item', className)}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator>
        <Check size={15} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function Tabs({ className, ...props }: Styled<ComponentProps<typeof TabsPrimitive.Root>>) {
  return <TabsPrimitive.Root className={classes('ui-tabs', className)} {...props} />;
}
export function TabsList({
  className,
  ...props
}: Styled<ComponentProps<typeof TabsPrimitive.List>>) {
  return <TabsPrimitive.List className={classes('ui-tabs-list', className)} {...props} />;
}
export function TabsTrigger({
  className,
  ...props
}: Styled<ComponentProps<typeof TabsPrimitive.Tab>>) {
  return <TabsPrimitive.Tab className={classes('ui-tabs-trigger', className)} {...props} />;
}
export function TabsContent({
  className,
  ...props
}: Styled<ComponentProps<typeof TabsPrimitive.Panel>>) {
  return <TabsPrimitive.Panel className={classes('ui-tabs-content', className)} {...props} />;
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  keepMounted,
  ...props
}: Styled<ComponentProps<typeof DialogPrimitive.Popup>> & {
  showCloseButton?: boolean;
  keepMounted?: boolean;
}) {
  return (
    <DialogPrimitive.Portal keepMounted={keepMounted}>
      <DialogPrimitive.Backdrop className="ui-dialog-backdrop" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={classes('ui-dialog-content', className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            render={<Button variant="ghost" size="icon" />}
            className="ui-dialog-close"
            aria-label="Close dialog"
          >
            <X size={18} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}
export function DialogTitle({
  className,
  ...props
}: Styled<ComponentProps<typeof DialogPrimitive.Title>>) {
  return <DialogPrimitive.Title className={classes('ui-dialog-title', className)} {...props} />;
}
export function DialogDescription({
  className,
  ...props
}: Styled<ComponentProps<typeof DialogPrimitive.Description>>) {
  return (
    <DialogPrimitive.Description
      className={classes('ui-dialog-description', className)}
      {...props}
    />
  );
}
export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-dialog-header', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-dialog-footer', className)} {...props} />;
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverTitle = PopoverPrimitive.Title;
export const PopoverDescription = PopoverPrimitive.Description;
export function PopoverContent({
  className,
  sideOffset = 8,
  align = 'center',
  ...props
}: Styled<ComponentProps<typeof PopoverPrimitive.Popup>> &
  Pick<PopoverPrimitive.Positioner.Props, 'sideOffset' | 'align'>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner className="ui-positioner" sideOffset={sideOffset} align={align}>
        <PopoverPrimitive.Popup className={classes('ui-popover-content', className)} {...props} />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = 'start',
  side = 'bottom',
  alignOffset = 0,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.Popup>> &
  Pick<MenuPrimitive.Positioner.Props, 'sideOffset' | 'align' | 'side' | 'alignOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="ui-positioner"
        sideOffset={sideOffset}
        align={align}
        side={side}
        alignOffset={alignOffset}
      >
        <MenuPrimitive.Popup className={classes('ui-menu-content', className)} {...props} />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}
export function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.Item>> & {
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      className={classes('ui-menu-item', className)}
      data-variant={variant}
      {...props}
    />
  );
}
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuPortal = MenuPrimitive.Portal;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;
export const DropdownMenuSub = MenuPrimitive.SubmenuRoot;
export function DropdownMenuLabel({
  className,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.GroupLabel>>) {
  return <MenuPrimitive.GroupLabel className={classes('ui-menu-label', className)} {...props} />;
}
export function DropdownMenuSeparator({
  className,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.Separator>>) {
  return <MenuPrimitive.Separator className={classes('ui-menu-separator', className)} {...props} />;
}
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span className={classes('ui-menu-shortcut', className)} {...props} />;
}
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.RadioItem>>) {
  return (
    <MenuPrimitive.RadioItem className={classes('ui-menu-item', className)} {...props}>
      <MenuPrimitive.RadioItemIndicator>
        <Check size={14} />
      </MenuPrimitive.RadioItemIndicator>
      {children}
    </MenuPrimitive.RadioItem>
  );
}
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.CheckboxItem>>) {
  return (
    <MenuPrimitive.CheckboxItem className={classes('ui-menu-item', className)} {...props}>
      <MenuPrimitive.CheckboxItemIndicator>
        <Check size={14} />
      </MenuPrimitive.CheckboxItemIndicator>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}
export function DropdownMenuSubTrigger({
  className,
  ...props
}: Styled<ComponentProps<typeof MenuPrimitive.SubmenuTrigger>>) {
  return <MenuPrimitive.SubmenuTrigger className={classes('ui-menu-item', className)} {...props} />;
}
export function DropdownMenuSubContent(props: ComponentProps<typeof DropdownMenuContent>) {
  return <DropdownMenuContent side="right" {...props} />;
}

export function Accordion({
  className,
  ...props
}: Styled<ComponentProps<typeof AccordionPrimitive.Root>>) {
  return <AccordionPrimitive.Root className={classes('ui-accordion', className)} {...props} />;
}
export function AccordionItem({
  className,
  ...props
}: Styled<ComponentProps<typeof AccordionPrimitive.Item>>) {
  return <AccordionPrimitive.Item className={classes('ui-accordion-item', className)} {...props} />;
}
export function AccordionTrigger({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof AccordionPrimitive.Trigger>>) {
  return (
    <AccordionPrimitive.Header className="ui-accordion-header">
      <AccordionPrimitive.Trigger className={classes('ui-accordion-trigger', className)} {...props}>
        {children}
        <ChevronDown size={17} />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}
export function AccordionContent({
  className,
  ...props
}: Styled<ComponentProps<typeof AccordionPrimitive.Panel>>) {
  return (
    <AccordionPrimitive.Panel className={classes('ui-accordion-content', className)} {...props} />
  );
}

export function Badge({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'span'> & { variant?: Variant }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={classes('ui-badge', className)}
      {...props}
    />
  );
}
export function Alert({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & {
  variant?: 'default' | 'destructive' | 'success' | 'warning';
}) {
  return (
    <div
      role="alert"
      data-variant={variant}
      className={classes('ui-alert', className)}
      {...props}
    />
  );
}
export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-alert-title', className)} {...props} />;
}
export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-alert-description', className)} {...props} />;
}
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card" className={classes('ui-card', className)} {...props} />;
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-card-header', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-card-title', className)} {...props} />;
}
export function CardDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-card-description', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-card-content', className)} {...props} />;
}
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={classes('ui-card-footer', className)} {...props} />;
}

export function Progress({
  className,
  children,
  ...props
}: Styled<ComponentProps<typeof ProgressPrimitive.Root>>) {
  return (
    <ProgressPrimitive.Root className={classes('ui-progress', className)} {...props}>
      {children}
      <ProgressPrimitive.Track className="ui-progress-track">
        <ProgressPrimitive.Indicator className="ui-progress-indicator" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}
export const ProgressLabel = ProgressPrimitive.Label;
export const ProgressValue = ProgressPrimitive.Value;
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="ui-table-container">
      <table className={classes('ui-table', className)} {...props} />
    </div>
  );
}
export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={classes('ui-table-header', className)} {...props} />;
}
export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={classes('ui-table-body', className)} {...props} />;
}
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={classes('ui-table-row', className)} {...props} />;
}
export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={classes('ui-table-head', className)} {...props} />;
}
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={classes('ui-table-cell', className)} {...props} />;
}
export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption className={classes('ui-table-caption', className)} {...props} />;
}
export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: Styled<ComponentProps<typeof SeparatorPrimitive>>) {
  return (
    <SeparatorPrimitive
      className={classes('ui-separator', className)}
      orientation={orientation}
      {...props}
    />
  );
}
