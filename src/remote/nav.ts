/**
 * Navigation entries of the web UI: sidebar (≥ 900 px), bottom tab bar
 * (phones) and the «Mehr» page share these definitions.
 */
import {
  Boxes,
  ClipboardList,
  Ellipsis,
  LayoutDashboard,
  LayoutGrid,
  Monitor,
  Puzzle,
  Server,
  SquareKanban,
  type LucideIcon,
} from 'lucide-react';
import type { Route, RouteName } from './router';

export interface NavItem {
  route: RouteName;
  label: string;
  /** One line for the «Mehr» page. */
  description: string;
  icon: LucideIcon;
}

const ITEMS: Record<RouteName, NavItem> = {
  uebersicht: {
    route: 'uebersicht',
    label: 'Übersicht',
    description: 'Zustand des Kiosks und Schnellaktionen',
    icon: LayoutDashboard,
  },
  layout: { route: 'layout', label: 'Layout', description: 'Widgets anordnen und skalieren', icon: LayoutGrid },
  widgets: { route: 'widgets', label: 'Widgets', description: 'Einstellungen der einzelnen Widgets', icon: Puzzle },
  inhalte: { route: 'inhalte', label: 'Inhalte', description: 'Pinnwand und Aufgaben', icon: ClipboardList },
  lagra: { route: 'lagra', label: 'lagra', description: 'Verbindung zu lagra einrichten und prüfen', icon: Boxes },
  planbar: {
    route: 'planbar',
    label: 'planbar',
    description: 'Verbindung zu planbar einrichten und prüfen',
    icon: SquareKanban,
  },
  kiosk: {
    route: 'kiosk',
    label: 'Kiosk',
    description: 'Design, Bedienung, Bildschirmzeiten und Raster',
    icon: Monitor,
  },
  system: {
    route: 'system',
    label: 'System',
    description: 'Geräteinfo, Updates, Neustart, PIN und Sicherung',
    icon: Server,
  },
  mehr: { route: 'mehr', label: 'Mehr', description: 'Weitere Bereiche und Abmelden', icon: Ellipsis },
};

export const SIDEBAR_NAV: readonly NavItem[] = [
  ITEMS.uebersicht,
  ITEMS.layout,
  ITEMS.widgets,
  ITEMS.inhalte,
  ITEMS.lagra,
  ITEMS.planbar,
  ITEMS.kiosk,
  ITEMS.system,
];

export const TAB_NAV: readonly NavItem[] = [ITEMS.uebersicht, ITEMS.layout, ITEMS.widgets, ITEMS.inhalte, ITEMS.mehr];

/** Pages reached through «Mehr» on phones. */
export const MORE_NAV: readonly NavItem[] = [ITEMS.lagra, ITEMS.planbar, ITEMS.kiosk, ITEMS.system];

/** «Mehr» stays highlighted while one of its pages is open. */
export function isNavActive(item: NavItem, route: Route | null): boolean {
  if (!route) return false;
  if (item.route === 'mehr') return route.name === 'mehr' || MORE_NAV.some((entry) => entry.route === route.name);
  return item.route === route.name;
}
