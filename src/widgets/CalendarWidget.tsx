/**
 * Calendar Widget – Office 365 Calendar with Mock Data
 * Inspired by Screenshot 2 calendar section.
 * Shows today's events and upcoming ones.
 */
import React, { useMemo } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockCalendarEvents } from '../utils/mockData';
import type { CalendarEvent } from '../types/calendar';

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

const CalendarComponent: React.FC<WidgetProps> = () => {
  const grouped = useMemo(() => {
    const groups = new Map<string, CalendarEvent[]>();
    const sorted = [...mockCalendarEvents].sort((a, b) => a.start.getTime() - b.start.getTime());
    for (const ev of sorted) {
      const key = ev.start.toDateString();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ev);
    }
    return groups;
  }, []);

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {Array.from(grouped.entries()).map(([dateKey, events]) => (
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
      ))}
    </div>
  );
};

export const calendarWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'calendar',
    name: 'Kalender',
    description: 'Office 365 Termine (Mock)',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 3,
    defaultWidth: 5,
    defaultHeight: 6,
    permissions: ['calendar.read'],
    refreshInterval: 300,
  },
  component: CalendarComponent,
};
