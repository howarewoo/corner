import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, useLocation, useSearchParams } from 'react-router';
import { ArrowLeft, ArrowRight, Check, Layers3, Moon, Sun } from 'lucide-react';
import {
  AppSidebar,
  Button,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  Toaster,
  TooltipProvider,
  WorkspaceHeader,
  useSidebar,
} from '@packages/ui';
import { catalog, Specimen } from './specimens';
import '@packages/ui/utilities.css';
import '@packages/ui/theme.css';
import '@packages/ui/styles.css';
import './styles.css';

const groups = [...new Set(catalog.map((item) => item.group))];

function CatalogApp() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const component = params.get('component');
  const foundIndex = catalog.findIndex((entry) => entry.id === component);
  const index = foundIndex >= 0 ? foundIndex : 0;
  const item = catalog[index];
  const selected = item.id;
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.cornerTheme === 'dark' ? 'dark' : 'light',
  );
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar();
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLElement>(null);
  const selectedFromDrawer = useRef(false);
  const focusSearchWhenExpanded = useRef(false);

  const sidebarGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? catalog.filter((entry) =>
          `${entry.label} ${entry.group} ${entry.description}`.toLowerCase().includes(q),
        )
      : catalog;
    return groups.map((group) => ({
      label: group,
      items: matches
        .filter((entry) => entry.group === group)
        .map((entry) => ({
          id: entry.id,
          label: entry.label,
          href: `?component=${entry.id}`,
        })),
    }));
  }, [query]);

  useEffect(() => {
    setOpenMobile(false);
    content.current?.scrollTo({ top: 0 });
    if (!selectedFromDrawer.current) heading.current?.focus();
  }, [location.key, setOpenMobile]);
  useEffect(() => {
    document.title = `${item.label} · Corner Design`;
  }, [item.label]);
  useEffect(() => {
    if (openMobile) selectedFromDrawer.current = false;
  }, [openMobile]);
  useEffect(() => {
    if (!isMobile && open && focusSearchWhenExpanded.current) {
      focusSearchWhenExpanded.current = false;
      search.current?.focus();
    }
  }, [isMobile, open]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'k' ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      )
        return;
      event.preventDefault();
      if (isMobile) {
        setOpenMobile(true);
      } else if (!open) {
        focusSearchWhenExpanded.current = true;
        setOpen(true);
      } else search.current?.focus();
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [isMobile, open, setOpen, setOpenMobile]);

  function navigate(id: string) {
    if (selected === id) return;
    const next = new URLSearchParams(params);
    next.set('component', id);
    setParams(next);
  }
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.cornerTheme = next;
    document.documentElement.classList.toggle('dark', next === 'dark');
    setTheme(next);
    try {
      localStorage.setItem('corner-design-theme', next);
    } catch {
      /* Appearance still works without persistent storage. */
    }
  }

  return (
    <>
      <a className="skip-link" href="#specimen">
        Skip to component
      </a>
      <AppSidebar
        id="catalog-navigation"
        label="Component navigation"
        brand={{ id: 'colors', label: 'Corner Design home', href: '?component=colors' }}
        caption={`Design system · ${catalog.length} entries`}
        selectedId={selected}
        selectedIndicator
        onSelect={navigate}
        renderLink={({ href, ...props }) => (
          <Link
            {...props}
            to={href!}
            onClick={() => {
              selectedFromDrawer.current = openMobile;
            }}
          />
        )}
        groups={sidebarGroups}
        search={{
          value: query,
          onChange: setQuery,
          label: 'Search components',
          placeholder: 'Find a component…',
          inputRef: search,
        }}
        empty={{
          message: 'No matching components.',
          actionLabel: 'Clear search',
          onAction: () => {
            setQuery('');
            search.current?.focus();
          },
        }}
        footer={{
          icon: <Layers3 size={18} />,
          title: 'Shared by design',
          description: 'Base UI · Complete catalog',
        }}
        mobileContentProps={{
          initialFocus: search,
          finalFocus: () => (selectedFromDrawer.current ? heading.current : trigger.current),
        }}
      />
      <SidebarInset>
        <header className="design-topbar">
          <div className="breadcrumb">
            <SidebarTrigger ref={trigger} aria-label="Toggle component navigation" />
            <span className="breadcrumb-root">Corner Design</span>
            <span className="breadcrumb-divider">/</span>
            <span>{item.label}</span>
          </div>
          <div className="topbar-actions">
            <span className="local-label">
              <span />
              Developer catalog
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </Button>
          </div>
        </header>
        <section id="specimen" ref={content} className="catalog-content scroll-fade" tabIndex={-1}>
          <WorkspaceHeader
            title={item.label}
            description={item.description}
            titleRef={heading}
            actions={
              isMobile ? undefined : (
                <>
                  <span className="component-origin">
                    <Check size={14} />
                    {item.group === 'Foundations' ? 'Corner tokens' : 'Shared component'}
                  </span>
                </>
              )
            }
          />
          <div className="source-line">
            <span>Source</span>
            <code>{item.importPath}</code>
            <span className="source-note">Live previews · no backend required</span>
          </div>
          <Specimen key={selected} id={selected} />
          <nav className="page-pagination" aria-label="Adjacent components">
            {index > 0 ? (
              <Link to={`?component=${catalog[index - 1].id}`}>
                <ArrowLeft size={16} />
                <span>
                  <small>Previous</small>
                  {catalog[index - 1].label}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {index < catalog.length - 1 && (
              <Link to={`?component=${catalog[index + 1].id}`}>
                <span>
                  <small>Next</small>
                  {catalog[index + 1].label}
                </span>
                <ArrowRight size={16} />
              </Link>
            )}
          </nav>
          <footer className="catalog-footer">
            <span>Corner’s everyday building blocks.</span>
            <span>Project-owned source · MIT upstream controls</span>
          </footer>
        </section>
      </SidebarInset>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        <Toaster>
          <SidebarProvider>
            <CatalogApp />
          </SidebarProvider>
        </Toaster>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
);
