/**
 * TopBar – Minimal toolbar with theme toggle, edit mode, widget picker, and updater.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sun, Moon, Settings, Plus, Check, RefreshCw, Download, AlertCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useThemeStore } from '../store/themeStore';
import { useLayoutStore } from '../store/layoutStore';
import { getAllWidgets } from '../utils/widgetRegistry';
import { v4Style } from '../utils/uid';

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'updating' | 'error';

interface UpdateInfo {
  available: boolean;
  current_commit: string;
  remote_commit: string;
  short_current: string;
  short_remote: string;
}

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
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateMessage, setUpdateMessage] = useState('');
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError(null);
    try {
      const info = await invoke<UpdateInfo>('check_for_updates');
      setUpdateInfo(info);
      setUpdateStatus(info.available ? 'available' : 'up-to-date');
    } catch (err) {
      setUpdateError(err as string);
      setUpdateStatus('error');
    }
  }, []);

  // Check on mount
  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  const handleUpdate = async () => {
    setUpdateStatus('updating');
    setUpdatePercent(2);
    setUpdateMessage('Update gestartet…');
    try {
      await invoke('trigger_update');
      // Fortschritt alle 3 Sekunden vom Log lesen
      progressPollRef.current = setInterval(async () => {
        try {
          const p = await invoke<{ percent: number; message: string; done: boolean; error: boolean }>('get_update_progress');
          setUpdatePercent(p.percent);
          setUpdateMessage(p.message);
          if (p.done) {
            clearInterval(progressPollRef.current!);
            setUpdateStatus('up-to-date');
          } else if (p.error) {
            clearInterval(progressPollRef.current!);
            setUpdateError(p.message);
            setUpdateStatus('error');
          }
        } catch { /* ignorieren */ }
      }, 3000);
    } catch (err) {
      setUpdateError(err as string);
      setUpdateStatus('error');
    }
  };

  useEffect(() => {
    return () => { if (progressPollRef.current) clearInterval(progressPollRef.current); };
  }, []);

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
        {/* Update Button */}
        {updateStatus === 'available' && (
          <button
            style={{ ...styles.btn, background: 'var(--accent-color)', color: '#fff', borderColor: 'var(--accent-color)' }}
            onClick={handleUpdate}
            title={`Update verfügbar: ${updateInfo?.short_current} → ${updateInfo?.short_remote}`}
          >
            <Download size={16} />
            Update möglich
          </button>
        )}
        {updateStatus === 'updating' && (
          <span style={{ ...styles.btn, cursor: 'default', flexDirection: 'column', gap: 2, padding: '4px 10px', minWidth: 140 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
              <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{updatePercent}%</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{updateMessage}</span>
            </span>
            <div style={{ width: '100%', height: 3, background: 'var(--border-color)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${updatePercent}%`, background: 'var(--accent-color)', borderRadius: 2, transition: 'width 1s ease' }} />
            </div>
          </span>
        )}
        {updateStatus === 'checking' && (
          <span style={{ ...styles.btn, opacity: 0.5, cursor: 'default', fontSize: 12 }}>
            <RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} />
          </span>
        )}
        {updateStatus === 'error' && (
          <button
            style={{ ...styles.btn, color: 'var(--error-color, #ef4444)' }}
            onClick={checkForUpdates}
            title={updateError ?? 'Update-Fehler – erneut versuchen'}
          >
            <AlertCircle size={16} />
          </button>
        )}
        {updateStatus === 'up-to-date' && (
          <button
            style={{ ...styles.btn, opacity: 0.6 }}
            onClick={checkForUpdates}
            title={`Aktuell (${updateInfo?.short_current}) – erneut prüfen`}
          >
            <Check size={16} />
          </button>
        )}
        {updateStatus === 'idle' && (
          <button
            style={{ ...styles.btn, opacity: 0.6 }}
            onClick={checkForUpdates}
            title="Auf Updates prüfen"
          >
            <RefreshCw size={16} />
          </button>
        )}
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
