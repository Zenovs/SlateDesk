/**
 * Weather Widget – Shows weather forecast (mock data).
 * Inspired by Screenshot 2 weather section.
 */
import React from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockWeatherData } from '../utils/mockData';

const WeatherComponent: React.FC<WidgetProps> = () => {
  const today = mockWeatherData[0];
  const forecast = mockWeatherData.slice(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* Current */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        flex: 1,
      }}>
        <span style={{ fontSize: 48 }}>{today.icon}</span>
        <div>
          <div style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 'var(--font-weight-bold)',
            color: 'var(--text-primary)',
          }}>
            {today.tempHigh}°C
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            {today.condition}
          </div>
        </div>
      </div>
      {/* Forecast row */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-around',
        borderTop: '1px solid var(--border-color)',
        paddingTop: 10,
      }}>
        {forecast.map((f) => (
          <div key={f.day} style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{f.day}</div>
            <div style={{ fontSize: 22, margin: '4px 0' }}>{f.icon}</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
              {f.tempLow}° <span style={{ color: 'var(--text-tertiary)' }}>/</span> {f.tempHigh}°
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export const weatherWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'weather',
    name: 'Wetter',
    description: 'Wettervorhersage (Mock)',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 2,
    defaultWidth: 4,
    defaultHeight: 3,
    permissions: ['network'],
    refreshInterval: 1800,
  },
  component: WeatherComponent,
};
