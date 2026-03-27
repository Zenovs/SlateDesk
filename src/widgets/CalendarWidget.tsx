/**
 * Calendar Widget – Office 365 Calendar with Settings.
 * Settings: Source, event count, time range.
 */
import React, { useMemo, useState, useEffect } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockCalendarEvents } from '../utils/mockData';
import type { CalendarEvent } from '../types/calendar';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface CalendarSettings {
  source: 'mock' | 'office365';
  maxEvents: number;
  timeRange: 'today' | 'week' | 'month';
}

const DEFAULT_SETTINGS: CalendarSettings = {
  source: 'mock',
  maxEvents: 6,
  timeRange: 'week',
};

const formatTime = (d: Date) =>
  d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

const isToday = (d: Date) => {
  const now = new Date();
  return d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear();
};

const formatDayLabel = (d: Date) => {
  if (isToday(d)) return 'Heute';
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.getDate() === tomorrow.getDate() && d.getMonth() === tomorrow.getMonth())
    return 'Morgen';
  return d.toLocaleDateString('de-CH', { weekday: 'short', day: 'numeric', month: 'short' });
};

const EventItem: React.FC<{ event: CalendarEvent }> = ({ event }) => (
  <div style={{
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '8px 0',
    borderBottom: '1px solid var(--border-color)',
  }}>
    <div style={{
      width: 3,
      height: 36,
      borderRadius: 2,
      background: event.color || 'var(--accent-color)',
      flexShrink: 0,
      marginTop: 2,
    }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        fontSize: 'var(--font-size-sm)',
        fontWeight: 'var(--font-weight-medium)',
        color: 'var(--text-primary)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {event.title}
      </div>
      <div style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-tertiary)',
        display: 'flex',
        gap: 8,
        marginTop: 2,
      }}>
        <span>
          {event.isAllDay ? 'Ganztägig' : `${formatTime(event.start)} – ${formatTime(event.end)}`}
        </span>
        {event.location && (
          <span style={{ opacity: 0.7 }}>· {event.location}</span>
        )}
      </div>
    </div>
    {event.status === 'tentative' && (
      <span style={{
        fontSize: 10,
        color: 'var(--warning)',
        border: '1px solid var(--warning)',
        borderRadius: 4,
        padding: '1px 5px',
        flexShrink: 0,
      }}>?</span>
    )}
  </div>
);

const CalendarComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<CalendarSettings>(instanceId, DEFAULT_SETTINGS);

  // Listen for settings open event
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const filteredEvents = useMemo(() => {
    const now = new Date();
    let endDate = new Date();

    switch (settings.timeRange) {
      case 'today':
        endDate.setHours(23, 59, 59, 999);
        break;
      case 'week':
        endDate.setDate(endDate.getDate() + 7);
        break;
      case 'month':
        endDate.setMonth(endDate.getMonth() + 1);
        break;
    }

    return mockCalendarEvents
      .filter(ev => ev.start >= now && ev.start <= endDate)
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, settings.maxEvents);
  }, [settings.timeRange, settings.maxEvents]);

  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarEvent[]>();
    for (const ev of filteredEvents) {
      const key = ev.start.toDateString();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ev);
    }
    return groups;
  }, [filteredEvents]);

  return (
    <>
      <div style={{ height: '100%', overflow: 'auto' }}>
        {grouped.size === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)',
          }}>
            📅 Keine Termine im gewählten Zeitraum
          </div>
        ) : (
          Array.from(grouped.entries()).map(([dateKey, events]) => (
            <div key={dateKey} style={{ marginBottom: 16 }}>
              <div style={{
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-accent)',
                fontWeight: 'var(--font-weight-bold)',
                textTransform: 'uppercase',
                letterSpacing: 1,
                marginBottom: 6,
              }}>
                {formatDayLabel(events[0].start)}
              </div>
              {events.map((ev) => (
                <EventItem key={ev.id} event={ev} />
              ))}
            </div>
          ))
        )}
      </div>

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Kalender"
      >
        <div className="settings-section">
          <div className="settings-section-title">Datenquelle</div>
          <div className="settings-field">
            <label className="settings-label">Kalender-Quelle</label>
            <select
              className="settings-select"
              value={settings.source}
              onChange={(e) => updateSettings(instanceId, { source: e.target.value })}
            >
              <option value="mock">Mock-Daten (Demo)</option>
              <option value="office365" disabled>Office 365 (kommt bald)</option>
            </select>
            <p className="settings-description" style={{ marginTop: 4 }}>
              Office 365 Integration wird in einer zukünftigen Version verfügbar sein.
            </p>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Anzeige</div>
          
          <div className="settings-field">
            <label className="settings-label">Zeitbereich</label>
            <div className="settings-radio-group">
              {([
                { value: 'today', label: 'Heute' },
                { value: 'week', label: 'Diese Woche' },
                { value: 'month', label: 'Dieser Monat' },
              ] as const).map(opt => (
                <label
                  key={opt.value}
                  className={`settings-radio-option ${settings.timeRange === opt.value ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="timeRange"
                    value={opt.value}
                    checked={settings.timeRange === opt.value}
                    onChange={() => updateSettings(instanceId, { timeRange: opt.value })}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Maximale Anzahl Termine</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <input
                type="range"
                className="settings-range"
                min={1}
                max={10}
                value={settings.maxEvents}
                onChange={(e) => updateSettings(instanceId, { maxEvents: parseInt(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="settings-range-value">{settings.maxEvents}</span>
            </div>
          </div>
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const calendarWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'calendar',
    name: 'Kalender',
    description: 'Office 365 Termine (Mock)',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 3,
    defaultWidth: 5,
    defaultHeight: 6,
    permissions: ['calendar.read'],
    refreshInterval: 300,
    hasSettings: true,
  },
  component: CalendarComponent,
};
