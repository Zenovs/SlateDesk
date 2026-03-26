/**
 * Clock Widget – Displays current time and date.
 * Inspired by Screenshot 2 ("THU 15.05.14 22:13")
 */
import React, { useEffect, useState } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';

const formatTime = (d: Date) =>
  d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

const formatDate = (d: Date) => {
  const days = ['SO', 'MO', 'DI', 'MI', 'DO', 'FR', 'SA'];
  const day = days[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${day}  ${dd}.${mm}.${yy}`;
};

const ClockComponent: React.FC<WidgetProps> = () => {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 4,
    }}>
      <div style={{
        fontSize: 'var(--font-size-xs)',
        color: 'var(--text-tertiary)',
        letterSpacing: 2,
        fontWeight: 'var(--font-weight-medium)',
      }}>
        {formatDate(now)}
      </div>
      <div style={{
        fontSize: 'var(--font-size-3xl)',
        fontWeight: 'var(--font-weight-light)',
        color: 'var(--text-primary)',
        letterSpacing: 2,
        lineHeight: 1,
      }}>
        {formatTime(now)}
      </div>
    </div>
  );
};

export const clockWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'clock',
    name: 'Uhr',
    description: 'Aktuelle Uhrzeit und Datum',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 3,
    defaultHeight: 3,
    permissions: [],
  },
  component: ClockComponent,
};
