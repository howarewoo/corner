import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Layers3,
  Moon,
  Search,
  Sun,
  X,
} from "lucide-react";
import {
  Button,
  Input,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  SonnerToaster,
  Toaster,
  TooltipProvider,
  useSidebar,
} from "@packages/ui";
import { catalog, Specimen } from "./specimens";
import "@packages/ui/utilities.css";
import "@packages/ui/theme.css";
import "@packages/ui/styles.css";
import "./styles.css";

const groups = [...new Set(catalog.map((item) => item.group))];
function selectedId() {
  const id = new URLSearchParams(window.location.search).get("component");
  return catalog.some((item) => item.id === id) ? id! : "colors";
}

function CatalogApp() {
  const [selected, setSelected] = useState(selectedId);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.dataset.cornerTheme === "dark" ? "dark" : "light",
  );
  const { open, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar();
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const selectedFromDrawer = useRef(false);
  const focusSearchWhenExpanded = useRef(false);
  const item = catalog.find((entry) => entry.id === selected)!;
  const index = catalog.indexOf(item);
  const matches = catalog.filter((entry) =>
    `${entry.label} ${entry.group} ${entry.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );

  useEffect(() => {
    const restore = () => {
      setSelected(selectedId());
      setOpenMobile(false);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [setOpenMobile]);
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
        event.key.toLowerCase() !== "k" ||
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
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [isMobile, open, setOpen, setOpenMobile]);

  function navigate(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("component", id);
    if (selected !== id) window.history.pushState({}, "", url);
    setSelected(id);
    selectedFromDrawer.current = openMobile;
    setOpenMobile(false);
    if (!openMobile) heading.current?.focus();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.cornerTheme = next;
    document.documentElement.classList.toggle("dark", next === "dark");
    setTheme(next);
    try {
      localStorage.setItem("corner-design-theme", next);
    } catch {
      /* Appearance still works without persistent storage. */
    }
  }
  const selectLink = (
    event: React.MouseEvent<HTMLAnchorElement>,
    id: string,
  ) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(id);
  };

  return (
    <>
      <a className="skip-link" href="#specimen">
        Skip to component
      </a>
      <Sidebar
        variant="floating"
        className="catalog-sidebar"
        mobileContentProps={{
          showCloseButton: false,
          initialFocus: search,
          finalFocus: () =>
            selectedFromDrawer.current ? heading.current : trigger.current,
        }}
      >
        <SidebarHeader className="catalog-sidebar-header">
          <div className="catalog-brand-row">
            <a
              className="design-brand"
              href="?component=colors"
              onClick={(event) => selectLink(event, "colors")}
              aria-label="Corner Design home"
            >
              <span className="brand-mark" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                corner<span className="brand-period">.</span>
              </span>
            </a>
            <Button
              className="catalog-close"
              variant="ghost"
              size="icon"
              aria-label="Close component navigation"
              onClick={() => setOpenMobile(false)}
            >
              <X size={18} />
            </Button>
          </div>
          <div className="brand-caption">
            Design system · {catalog.length} entries
          </div>
          <div className="catalog-search">
            <Search size={17} aria-hidden="true" />
            <Input
              ref={search}
              type="search"
              aria-label="Search components"
              placeholder="Find a component…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Clear component search"
                onClick={() => {
                  setQuery("");
                  search.current?.focus();
                }}
              >
                <X size={15} />
              </Button>
            )}
          </div>
        </SidebarHeader>
        <SidebarContent className="catalog-sidebar-content">
          <nav aria-label="Component catalog">
            {groups.map((group) => {
              const entries = matches.filter((entry) => entry.group === group);
              return (
                entries.length > 0 && (
                  <SidebarGroup className="nav-group" key={group}>
                    <SidebarGroupLabel render={<h2 />}>
                      {group}
                    </SidebarGroupLabel>
                    <SidebarMenu>
                      {entries.map((entry) => (
                        <SidebarMenuItem key={entry.id}>
                          <SidebarMenuButton
                            isActive={selected === entry.id}
                            render={
                              <a
                                href={`?component=${entry.id}`}
                                aria-current={
                                  selected === entry.id ? "page" : undefined
                                }
                                onClick={(event) => selectLink(event, entry.id)}
                              />
                            }
                          >
                            <span>{entry.label}</span>
                            {selected === entry.id && (
                              <ChevronRight size={15} aria-hidden="true" />
                            )}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                )
              );
            })}
            {matches.length === 0 && (
              <div className="nav-empty" role="status">
                <p>No matching components.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  Clear search
                </Button>
              </div>
            )}
          </nav>
        </SidebarContent>
        <SidebarFooter className="sidebar-foot">
          <span className="library-symbol">
            <Layers3 size={18} />
          </span>
          <div>
            <strong>Shared by design</strong>
            <span>Base UI · Complete catalog</span>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="design-main">
        <header className="design-topbar">
          <div className="breadcrumb">
            <SidebarTrigger
              ref={trigger}
              aria-label="Toggle component navigation"
            />
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
              aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </Button>
          </div>
        </header>
        <section id="specimen" className="catalog-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {item.label}
              </h1>
              <p>{item.description}</p>
            </div>
            <span className="component-origin">
              <Check size={14} />
              {item.group === "Foundations"
                ? "Corner tokens"
                : "Shared component"}
            </span>
          </div>
          <div className="source-line">
            <span>Source</span>
            <code>{item.importPath}</code>
            <span className="source-note">
              Live previews · no backend required
            </span>
          </div>
          <Specimen key={selected} id={selected} />
          <nav className="page-pagination" aria-label="Adjacent components">
            {index > 0 ? (
              <a
                href={`?component=${catalog[index - 1].id}`}
                onClick={(event) => selectLink(event, catalog[index - 1].id)}
              >
                <ArrowLeft size={16} />
                <span>
                  <small>Previous</small>
                  {catalog[index - 1].label}
                </span>
              </a>
            ) : (
              <span />
            )}
            {index < catalog.length - 1 && (
              <a
                href={`?component=${catalog[index + 1].id}`}
                onClick={(event) => selectLink(event, catalog[index + 1].id)}
              >
                <span>
                  <small>Next</small>
                  {catalog[index + 1].label}
                </span>
                <ArrowRight size={16} />
              </a>
            )}
          </nav>
          <footer className="catalog-footer">
            <span>Corner’s everyday building blocks.</span>
            <span>Project-owned source · MIT upstream controls</span>
          </footer>
        </section>
      </SidebarInset>
      <SonnerToaster theme={theme} closeButton />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Toaster>
        <SidebarProvider
          className="design-shell"
          style={{ "--sidebar-width": "258px" } as CSSProperties}
        >
          <CatalogApp />
        </SidebarProvider>
      </Toaster>
    </TooltipProvider>
  </StrictMode>,
);
