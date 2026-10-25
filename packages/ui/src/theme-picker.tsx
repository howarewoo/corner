import { Monitor, Moon, Sun } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './primitives';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from './catalog/sidebar';

export type ThemePreference = 'light' | 'dark' | 'system';

export type ThemePickerProps = {
  value: ThemePreference;
  onValueChange: (value: ThemePreference) => void;
  compact?: boolean;
};

const themes = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

/** Controlled appearance selection; the consuming application owns theme resolution. */
export function ThemePicker({ value, onValueChange, compact = false }: ThemePickerProps) {
  const selected = themes.find((theme) => theme.value === value)!;
  const Icon = selected.icon;
  const trigger = compact ? (
    <DropdownMenuTrigger
      aria-label="Choose theme"
      title={`Theme: ${selected.label}`}
      render={<Button variant="ghost" size="icon" />}
    >
      <Icon size={18} aria-hidden="true" />
    </DropdownMenuTrigger>
  ) : (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenuTrigger aria-label="Choose theme" render={<SidebarMenuButton />}>
          <Icon size={18} aria-hidden="true" />
          <span>Theme</span>
          <span className="ml-auto text-xs text-muted-foreground">{selected.label}</span>
        </DropdownMenuTrigger>
      </SidebarMenuItem>
    </SidebarMenu>
  );

  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent
        className="corner-ui min-w-40"
        side={compact ? 'bottom' : 'top'}
        align={compact ? 'end' : 'start'}
        aria-label="Theme"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              if (next === 'light' || next === 'dark' || next === 'system') onValueChange(next);
            }}
          >
            {themes.map(({ value: option, label, icon: OptionIcon }) => (
              <DropdownMenuRadioItem
                key={option}
                value={option}
                closeOnClick
                className="ui-theme-picker-item"
              >
                <OptionIcon size={16} aria-hidden="true" />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
