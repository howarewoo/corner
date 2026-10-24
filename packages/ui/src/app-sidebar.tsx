import * as React from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { Button, Input } from './primitives';
import { Avatar, AvatarFallback } from './catalog/avatar';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from './catalog/sidebar';

type SidebarEntry<Id extends string> = { id: Id; label: string; href?: string; icon?: React.ReactNode };
export type MobileNavigationItem<Id extends string> = {
  id: Id;
  label: string;
  icon?: React.ReactNode;
  href?: string;
};
export type MobileNavigation<Id extends string> = {
  label: string;
  selectedId: Id;
  items: MobileNavigationItem<Id>[];
};
export type AppSidebarProps<Id extends string> = {
  id: string;
  label: string;
  brand: { id: Id; label: string; href?: string };
  caption?: string;
  groups: { label?: string; items: SidebarEntry<Id>[] }[];
  selectedId: Id;
  onSelect: (id: Id) => void;
  renderLink?: (props: React.ComponentProps<'a'>) => React.ReactElement;
  selectedIndicator?: boolean;
  search?: { value: string; onChange: (value: string) => void; label: string; placeholder: string; inputRef?: React.RefObject<HTMLInputElement | null> };
  empty?: { message: string; actionLabel: string; onAction: () => void };
  profile?: { name: string; initial: string; icon?: React.ReactNode; label: string; selected: boolean; href?: string; onSelect: () => void };
  footer?: { icon: React.ReactNode; title: string; description: string };
  note?: string;
  mobileContentProps?: Pick<NonNullable<React.ComponentProps<typeof Sidebar>['mobileContentProps']>, 'initialFocus' | 'finalFocus' | 'className'>;
  mobileNavigation?: MobileNavigation<Id>;
};

/** One sidebar composition for product navigation and its live catalog example. */
export function AppSidebar<Id extends string>({
  id, label, brand, caption, groups, selectedId, onSelect, selectedIndicator = false,
  search, empty, profile, footer, note, mobileContentProps, mobileNavigation, renderLink,
}: AppSidebarProps<Id>) {
  const { isMobile, setOpenMobile } = useSidebar();
  const navigation = React.useRef<HTMLElement>(null);
  const link = (href: string) => renderLink ? renderLink({ href }) : <a href={href} />;
  function select(event: React.MouseEvent<HTMLElement>, target: Id, href?: string) {
    if (href && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    if (href && renderLink) { setOpenMobile(false); return; }
    event.preventDefault();
    onSelect(target);
    setOpenMobile(false);
  }
  if (isMobile && mobileNavigation) {
    return (
      <nav
        id={id}
        ref={navigation}
        data-slot="bottom-navigation"
        aria-label={mobileNavigation.label}
        className="ui-bottom-navigation"
      >
        <ul className="ui-bottom-navigation-list">
          {mobileNavigation.items.map((item) => {
            const isSelected = mobileNavigation.selectedId === item.id;
            return (
              <li key={item.id} className="ui-bottom-navigation-item">
                <Button
                  variant="ghost"
                  className="ui-bottom-navigation-button"
                  aria-label={item.label}
                  aria-current={isSelected ? 'page' : undefined}
                  data-active={isSelected ? '' : undefined}
                  nativeButton={!item.href}
                  role={item.href ? 'link' : undefined}
                  render={item.href ? link(item.href) : undefined}
                  onClick={(event) => select(event, item.id, item.href)}
                >
                  {item.icon && (
                    <span className="ui-bottom-navigation-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  )}
                  <span className="ui-bottom-navigation-label">{item.label}</span>
                </Button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  return <Sidebar variant="floating" id={id} aria-label={label}
    mobileTitle={label} mobileDescription="Choose a section to open."
    mobileContentProps={{
      id, showCloseButton: false,
      initialFocus: () => navigation.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? null,
      ...mobileContentProps,
    }}>
    <SidebarHeader className="ui-app-sidebar-header">
      <div className="ui-app-sidebar-brand-row">
        <Button variant="ghost" className="ui-app-sidebar-brand" aria-label={brand.label}
          nativeButton={!brand.href}
          role={brand.href ? 'link' : undefined}
          render={brand.href ? link(brand.href) : undefined}
          onClick={event => select(event, brand.id, brand.href)}>
          <span className="ui-app-sidebar-brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>corner<span className="ui-app-sidebar-brand-period">.</span></span>
        </Button>
        {isMobile && <Button variant="ghost" size="icon" aria-label={`Close ${label.toLowerCase()}`} onClick={() => setOpenMobile(false)}><X size={18} /></Button>}
      </div>
      {caption && <div className="ui-app-sidebar-caption">{caption}</div>}
      {search && <div className="ui-app-sidebar-search">
        <Search size={17} aria-hidden="true" />
        <Input ref={search.inputRef} type="search" aria-label={search.label} placeholder={search.placeholder} value={search.value} onChange={event => search.onChange(event.target.value)} />
        {search.value && <Button variant="ghost" size="icon" aria-label={`Clear ${search.label.toLowerCase()}`} onClick={() => { search.onChange(''); search.inputRef?.current?.focus(); }}><X size={15} /></Button>}
      </div>}
    </SidebarHeader>
    <SidebarContent><nav ref={navigation} aria-label={label}>
      {groups.filter(group => group.items.length > 0).map((group, index) => <SidebarGroup key={group.label || index}>
        {group.label && <SidebarGroupLabel render={<h2 />}>{group.label}</SidebarGroupLabel>}
        <SidebarMenu>{group.items.map(entry => <SidebarMenuItem key={entry.id}>
          <SidebarMenuButton isActive={selectedId === entry.id} aria-current={selectedId === entry.id ? 'page' : undefined}
            render={entry.href ? link(entry.href) : undefined}
            onClick={event => select(event, entry.id, entry.href)}>
            {entry.icon}<span>{entry.label}</span>{selectedIndicator && selectedId === entry.id && <ChevronRight size={15} aria-hidden="true" />}
          </SidebarMenuButton>
        </SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>)}
      {!groups.some(group => group.items.length) && empty && <div className="ui-app-sidebar-empty" role="status"><p>{empty.message}</p><Button variant="secondary" size="sm" onClick={empty.onAction}>{empty.actionLabel}</Button></div>}
    </nav></SidebarContent>
    {(note || profile || footer) && <SidebarFooter>
      {note && <p className="ui-app-sidebar-note" role="status">{note}</p>}
      {profile && <SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" isActive={profile.selected} aria-current={profile.selected ? 'page' : undefined} aria-label={profile.label} render={profile.href ? link(profile.href) : undefined} onClick={event => { if (profile.href && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return; if (!(profile.href && renderLink)) { event.preventDefault(); profile.onSelect(); } setOpenMobile(false); }}><Avatar><AvatarFallback>{profile.initial}</AvatarFallback></Avatar><span>{profile.name}</span>{profile.icon}</SidebarMenuButton></SidebarMenuItem></SidebarMenu>}
      {footer && <div className="ui-app-sidebar-footer-info"><span className="ui-app-sidebar-footer-icon">{footer.icon}</span><div><strong>{footer.title}</strong><span>{footer.description}</span></div></div>}
    </SidebarFooter>}
  </Sidebar>;
}
