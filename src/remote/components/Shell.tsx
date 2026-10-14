/**
 * App shell of the web UI: top bar (kiosk name, connection), left sidebar
 * on wide screens, bottom tab bar on phones, and the page for the route.
 */
import { useEffect, useRef } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { useKioskName } from '../hooks/useKioskName';
import { isNavActive, SIDEBAR_NAV, TAB_NAV, type NavItem } from '../nav';
import { ContentPage } from '../pages/ContentPage';
import { KioskPage } from '../pages/KioskPage';
import { LagraPage } from '../pages/LagraPage';
import { LayoutPage } from '../pages/LayoutPage';
import { MorePage } from '../pages/MorePage';
import { OverviewPage } from '../pages/OverviewPage';
import { PlanbarPage } from '../pages/PlanbarPage';
import { SystemPage } from '../pages/SystemPage';
import { WidgetDetailPage } from '../pages/WidgetDetailPage';
import { WidgetsPage } from '../pages/WidgetsPage';
import { DEFAULT_ROUTE, href, navigate, useRoute, type Route } from '../router';
import { ConnectionIndicator } from './ConnectionIndicator';
import { LogoutButton } from './LogoutButton';
import { ThemeChooser, ThemeToggle } from './ThemeControls';

function RoutePage({ route }: { route: Route }) {
  switch (route.name) {
    case 'uebersicht':
      return <OverviewPage />;
    case 'layout':
      return <LayoutPage />;
    case 'widgets':
      return route.params[0] ? <WidgetDetailPage key={route.params[0]} instanceId={route.params[0]} /> : <WidgetsPage />;
    case 'inhalte':
      return <ContentPage />;
    case 'lagra':
      return <LagraPage />;
    case 'planbar':
      return <PlanbarPage />;
    case 'kiosk':
      return <KioskPage />;
    case 'system':
      return <SystemPage />;
    case 'mehr':
      return <MorePage />;
  }
}

function NavLink({ item, route, variant }: { item: NavItem; route: Route | null; variant: 'sidebar' | 'tab' }) {
  const active = isNavActive(item, route);
  const Icon = item.icon;
  return (
    <a
      href={href(item.route)}
      className={`${variant === 'tab' ? 'r-tab' : 'r-nav-link'}${active ? ' is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className={variant === 'tab' ? 'r-tab-icon' : 'r-nav-icon'} aria-hidden="true">
        <Icon size={variant === 'tab' ? 22 : 20} />
      </span>
      <span className={variant === 'tab' ? 'r-tab-label' : 'r-nav-label'}>{item.label}</span>
    </a>
  );
}

function Logo() {
  return (
    <span className="r-logo" aria-hidden="true">
      <LayoutDashboard size={20} />
    </span>
  );
}

export function Shell() {
  const route = useRoute();
  const name = useKioskName();
  const mainRef = useRef<HTMLElement>(null);
  const routeKey = route ? [route.name, ...route.params].join('/') : '';
  const shownRoute = useRef(routeKey);

  useEffect(() => {
    if (route === null) navigate(href(DEFAULT_ROUTE), { replace: true });
  }, [route]);

  // New page: start at the top and move focus there (screen readers announce it).
  useEffect(() => {
    if (shownRoute.current === routeKey) return;
    shownRoute.current = routeKey;
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [routeKey]);

  return (
    <div className="r-shell">
      {/* A button, not «#r-main»: the hash is the route. */}
      <button type="button" className="r-skip-link" onClick={() => mainRef.current?.focus()}>
        Zum Inhalt springen
      </button>

      <aside className="r-sidebar">
        <div className="r-sidebar-brand">
          <Logo />
          <div className="r-brand-text">
            <span className="r-brand-name">SlateDesk</span>
            <span className="r-brand-sub">Fernsteuerung</span>
          </div>
        </div>
        <nav className="r-sidebar-nav" aria-label="Hauptnavigation">
          {SIDEBAR_NAV.map((item) => (
            <NavLink key={item.route} item={item} route={route} variant="sidebar" />
          ))}
        </nav>
        <div className="r-sidebar-footer">
          <ThemeChooser block compact />
          <LogoutButton block variant="ghost" />
        </div>
      </aside>

      <div className="r-main">
        <header className="r-topbar">
          <div className="r-topbar-brand">
            <Logo />
            <div className="r-brand-text">
              <span className="r-topbar-name">{name}</span>
              <span className="r-brand-sub">Fernsteuerung</span>
            </div>
          </div>
          <div className="r-topbar-actions">
            <ConnectionIndicator />
            <ThemeToggle />
          </div>
        </header>
        <main id="r-main" ref={mainRef} className="r-content" tabIndex={-1}>
          {route && <RoutePage route={route} />}
        </main>
      </div>

      <nav className="r-tabbar" aria-label="Hauptnavigation">
        {TAB_NAV.map((item) => (
          <NavLink key={item.route} item={item} route={route} variant="tab" />
        ))}
      </nav>
    </div>
  );
}
