/**
 * TopBar – Minimal toolbar with theme toggle, edit mode, and widget picker.
 */
import React, { useState } from 'react';
import { Sun, Moon, Settings, Plus, Check } from 'lucide-react';
import { useThemeStore } from '../store/themeStore';
import { useLayoutStore } from '../store/layoutStore';
import { getAllWidgets } from '../utils/widgetRegistry';
import { v4Style } from '../utils/uid';

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border-color)',
    zIndex: 1000,
    position: 'relative',
    height: 48,
    overflow: 'visible',
  },
  left: { display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 },
  right: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  logo: {
    fontSize: 18,
    fontWeight: 700,
    letterSpacing: 1.5,
    color: 'var(--text-primary)',
  },
  btn: {
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    whiteSpace: 'nowrap' as const,
    transition: 'all 150ms ease',
  },
  activeBtn: {
    background: 'var(--accent-color)',
    color: '#fff',
    borderColor: 'var(--accent-color)',
  },
  picker: {
    position: 'absolute',
    top: 48,
    right: 16,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 12,
    padding: 12,
    minWidth: 220,
    zIndex: 2000,
    boxShadow: 'var(--shadow-lg)',
  },
  pickerItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 13,
    color: 'var(--text-primary)',
    transition: 'background 150ms',
  },
};

export const TopBar: React.FC = () => {
  const { theme, toggleTheme } = useThemeStore();
  const { editMode, toggleEditMode, addWidget } = useLayoutStore();
  const [showPicker, setShowPicker] = useState(false);

  const widgets = getAllWidgets();

  const handleAddWidget = (widgetId: string) => {
    addWidget({
      instanceId: `${widgetId}-${v4Style()}`,
      widgetId,
      x: 0,
      y: Infinity, // place at bottom
      w: 4,
      h: 3,
    });
    setShowPicker(false);
  };

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <span style={styles.logo}>SLATEDESK</span>
      </div>
      <div style={styles.right}>
        <button
          style={styles.btn}
          onClick={toggleTheme}
          title={`Theme: ${theme}`}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          style={{ ...styles.btn, ...(editMode ? styles.activeBtn : {}) }}
          onClick={toggleEditMode}
          title="Layout bearbeiten"
        >
          {editMode ? <Check size={16} /> : <Settings size={16} />}
          {editMode ? 'Fertig' : 'Bearbeiten'}
        </button>
        {editMode && (
          <button
            style={styles.btn}
            onClick={() => setShowPicker(!showPicker)}
            title="Widget hinzufügen"
          >
            <Plus size={16} />
            Widget
          </button>
        )}
      </div>
      {showPicker && (
        <div style={styles.picker}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Widget hinzufügen
          </div>
          {widgets.map((w) => (
            <div
              key={w.manifest.id}
              style={styles.pickerItem}
              onClick={() => handleAddWidget(w.manifest.id)}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <Plus size={14} />
              <div>
                <div style={{ fontWeight: 500 }}>{w.manifest.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{w.manifest.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
