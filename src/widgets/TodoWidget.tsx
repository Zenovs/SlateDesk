/**
 * Todo Widget – Task list with configurable settings.
 * Settings: Sort order, filter, data source.
 */
import React, { useState, useEffect, useMemo } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockTodos } from '../utils/mockData';
import type { TodoItem } from '../utils/mockData';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

interface TodoSettings {
  sortBy: 'category' | 'name' | 'status';
  filter: 'all' | 'open' | 'done';
  source: 'local';
}

const DEFAULT_SETTINGS: TodoSettings = {
  sortBy: 'category',
  filter: 'all',
  source: 'local',
};

const CATEGORY_ORDER: Record<string, number> = { today: 0, tomorrow: 1, later: 2 };

const TodoComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [todos, setTodos] = useState<TodoItem[]>(mockTodos);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const settings = getSettings<TodoSettings>(instanceId, DEFAULT_SETTINGS);

  // Listen for settings open event
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, handler);
    return () => { eventBus.off(`widget:openSettings:${instanceId}`, handler); };
  }, [instanceId]);

  const toggleTodo = (id: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  };

  // Filter and sort
  const filteredTodos = useMemo(() => {
    let items = [...todos];

    // Apply filter
    if (settings.filter === 'open') items = items.filter(t => !t.done);
    if (settings.filter === 'done') items = items.filter(t => t.done);

    // Apply sort
    switch (settings.sortBy) {
      case 'name':
        items.sort((a, b) => a.text.localeCompare(b.text, 'de'));
        break;
      case 'status':
        items.sort((a, b) => Number(a.done) - Number(b.done));
        break;
      case 'category':
      default:
        items.sort((a, b) => (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9));
        break;
    }

    return items;
  }, [todos, settings.filter, settings.sortBy]);

  // Group by category only when sorting by category
  const categories: { key: TodoItem['category']; label: string }[] = [
    { key: 'today', label: 'HEUTE' },
    { key: 'tomorrow', label: 'MORGEN' },
    { key: 'later', label: 'SPÄTER' },
  ];

  const renderTodoItem = (todo: TodoItem) => (
    <div
      key={todo.id}
      onClick={() => toggleTodo(todo.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 0',
        cursor: 'pointer',
        borderBottom: '1px solid var(--border-color)',
      }}
    >
      <div style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: `2px solid ${todo.done ? 'var(--success)' : 'var(--border-color-hover)'}`,
        background: todo.done ? 'var(--success)' : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: 'all 150ms',
      }}>
        {todo.done && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
      </div>
      <span style={{
        fontSize: 'var(--font-size-sm)',
        color: todo.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
        textDecoration: todo.done ? 'line-through' : 'none',
        transition: 'color 150ms',
        flex: 1,
      }}>
        {todo.text}
      </span>
      {settings.sortBy !== 'category' && (
        <span style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-tertiary)',
          textTransform: 'capitalize',
        }}>
          {todo.category === 'today' ? 'Heute' : todo.category === 'tomorrow' ? 'Morgen' : 'Später'}
        </span>
      )}
    </div>
  );

  return (
    <>
      <div style={{ height: '100%', overflow: 'auto' }}>
        {filteredTodos.length === 0 ? (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)',
          }}>
            {settings.filter === 'done' ? '✅ Keine erledigten Aufgaben' :
             settings.filter === 'open' ? '🎉 Alle Aufgaben erledigt!' :
             '📝 Keine Aufgaben vorhanden'}
          </div>
        ) : settings.sortBy === 'category' ? (
          // Grouped by category
          categories.map((cat) => {
            const items = filteredTodos.filter((t) => t.category === cat.key);
            if (items.length === 0) return null;
            return (
              <div key={cat.key} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--text-accent)',
                  fontWeight: 'var(--font-weight-bold)',
                  letterSpacing: 1,
                  marginBottom: 6,
                }}>
                  {cat.label}
                </div>
                {items.map(renderTodoItem)}
              </div>
            );
          })
        ) : (
          // Flat list
          filteredTodos.map(renderTodoItem)
        )}
      </div>

      <WidgetSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Einstellungen: Aufgaben"
      >
        <div className="settings-section">
          <div className="settings-section-title">Anzeige</div>

          <div className="settings-field">
            <label className="settings-label">Sortierung</label>
            <select
              className="settings-select"
              value={settings.sortBy}
              onChange={(e) => updateSettings(instanceId, { sortBy: e.target.value })}
            >
              <option value="category">Nach Datum (Heute/Morgen/Später)</option>
              <option value="name">Nach Name (A-Z)</option>
              <option value="status">Nach Status (Offen zuerst)</option>
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Filter</label>
            <div className="settings-radio-group">
              {([
                { value: 'all', label: 'Alle' },
                { value: 'open', label: 'Offen' },
                { value: 'done', label: 'Erledigt' },
              ] as const).map(opt => (
                <label
                  key={opt.value}
                  className={`settings-radio-option ${settings.filter === opt.value ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="filter"
                    value={opt.value}
                    checked={settings.filter === opt.value}
                    onChange={() => updateSettings(instanceId, { filter: opt.value })}
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Datenquelle</div>
          <div className="settings-field">
            <label className="settings-label">Aufgaben-Quelle</label>
            <select
              className="settings-select"
              value={settings.source}
              onChange={(e) => updateSettings(instanceId, { source: e.target.value as 'local' })}
            >
              <option value="local">Lokal (Mock-Daten)</option>
            </select>
            <p className="settings-description" style={{ marginTop: 4 }}>
              Cloud-Synchronisierung wird in einer zukünftigen Version verfügbar sein.
            </p>
          </div>
        </div>
      </WidgetSettingsDialog>
    </>
  );
};

export const todoWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'todo',
    name: 'Aufgaben',
    description: 'Aufgabenliste',
    version: '2.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 4,
    defaultHeight: 3,
    permissions: [],
    hasSettings: true,
  },
  component: TodoComponent,
};
