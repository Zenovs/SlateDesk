import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** Small number after the label (hidden when 0). */
  count?: number;
  /** Screen-reader text for the count, e.g. «3 offen». */
  countLabel?: string;
}

export interface TabsProps<T extends string> {
  value: T;
  items: readonly TabItem<T>[];
  onChange: (value: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for the tab and panel ids (useId()) – the same as on the TabPanels. */
  idPrefix: string;
}

const tabId = (prefix: string, value: string): string => `${prefix}-tab-${value}`;
const panelId = (prefix: string, value: string): string => `${prefix}-panel-${value}`;

/** Tab bar (WAI-ARIA tabs: arrow keys, Home/End); pair every tab with a <TabPanel>. */
export function Tabs<T extends string>({ value, items, onChange, label, idPrefix }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = Math.max(0, items.findIndex((item) => item.value === value));
    const last = items.length - 1;
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % items.length
        : event.key === 'ArrowLeft'
          ? (index + last) % items.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].value);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div ref={listRef} className="r-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item) => {
        const active = item.value === value;
        const Icon = item.icon;
        const showCount = item.count !== undefined && item.count > 0;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.value)}
            aria-selected={active}
            aria-controls={panelId(idPrefix, item.value)}
            tabIndex={active ? 0 : -1}
            className={`r-tabs-item${active ? ' is-active' : ''}`}
            onClick={() => onChange(item.value)}
          >
            {Icon && <Icon size={18} aria-hidden="true" />}
            <span>{item.label}</span>
            {showCount && (
              <>
                <span className="r-tabs-count" aria-hidden="true">
                  {item.count}
                </span>
                <span className="r-sr-only">{`, ${item.countLabel ?? item.count}`}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  value: string;
  /** Only the active panel is shown (and rendered). */
  active: boolean;
  children?: ReactNode;
}

/** Content of one tab; inactive panels stay in the DOM empty and hidden, so every tab's aria-controls resolves. */
export function TabPanel({ idPrefix, value, active, children }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={panelId(idPrefix, value)}
      aria-labelledby={tabId(idPrefix, value)}
      className="r-tabpanel"
      hidden={!active}
    >
      {active && children}
    </div>
  );
}
