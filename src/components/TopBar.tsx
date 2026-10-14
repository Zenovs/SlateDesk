/**
 * TopBar – Minimal toolbar with theme toggle, edit mode, widget picker,
 * remote access info and updater.
 *
 * With kiosk.showTopBar off the bar is hidden; an invisible hot corner
 * (top right, 48×48) reveals it for 30 s – longer while an update is being
 * installed. In edit mode it is always shown. The updater state lives here,
 * so it survives the bar hiding.
 * Edit mode ends by itself after kiosk.editModeAutoExitMinutes without input.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Moon, Plus, Settings, Smartphone, Sun } from 'lucide-react';
import { useUpdater } from '../hooks/useUpdater';
import { useAppState } from '../state/appState';
import { useLayoutStore } from '../store/layoutStore';
import { useThemeStore } from '../store/themeStore';
import { isTauri } from '../utils/backend';
import { RemoteInfoDialog } from './RemoteInfoDialog';
import { UpdateButton } from './UpdateButton';
import { WidgetPicker } from './WidgetPicker';

const REVEAL_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

/** Leaves edit mode after `minutes` without pointer/keyboard activity (0 = never). */
function useEditModeAutoExit(editMode: boolean, minutes: number, exit: () => void): void {
  useEffect(() => {
    if (!editMode || !(minutes > 0)) return;
    const timeout = minutes * 60_000;
    let lastActivity = Date.now();
    let timer: ReturnType<typeof setTimeout>;

    const check = () => {
      const idle = Date.now() - lastActivity;
      if (idle >= timeout) exit();
      else timer = setTimeout(check, timeout - idle);
    };
    const onActivity = () => {
      lastActivity = Date.now();
    };

    const options: AddEventListenerOptions = { passive: true, capture: true };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, options);
    timer = setTimeout(check, timeout);
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity, options);
      clearTimeout(timer);
    };
  }, [editMode, minutes, exit]);
}

export const TopBar: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const editMode = useLayoutStore((s) => s.editMode);
  const setEditMode = useLayoutStore((s) => s.setEditMode);
  const showTopBar = useAppState((s) => s.state.kiosk.showTopBar);
  const allowLocalEditing = useAppState((s) => s.state.kiosk.allowLocalEditing);
  const autoExitMinutes = useAppState((s) => s.state.kiosk.editModeAutoExitMinutes);
  const kioskName = useAppState((s) => s.state.kiosk.name);
  const updater = useUpdater(isTauri());
  const holdReveal = updater.holdsBar;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  /** > 0 while a hidden bar is revealed; bumping it restarts the 30 s. */
  const [revealTick, setRevealTick] = useState(0);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);

  // Picker and remote dialog belong to an edit session: leaving edit mode
  // (button, auto-exit, web UI) closes them for good.
  const [editSession, setEditSession] = useState(editMode);
  if (editSession !== editMode) {
    setEditSession(editMode);
    if (!editMode) {
      setPickerOpen(false);
      setRemoteOpen(false);
    }
  }

  const exitEditMode = useCallback(() => setEditMode(false), [setEditMode]);
  useEditModeAutoExit(editMode, autoExitMinutes, exitEditMode);

  const closePicker = useCallback(() => setPickerOpen(false), []);
  const closeRemote = useCallback(() => setRemoteOpen(false), []);

  const inFlow = showTopBar || editMode;
  const revealed = !inFlow && revealTick > 0;

  useEffect(() => {
    if (revealTick === 0 || inFlow || holdReveal) return;
    const timer = setTimeout(() => setRevealTick(0), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealTick, inFlow, holdReveal]);

  if (!inFlow && !revealed) {
    return (
      <button
        type="button"
        className="topbar-hotcorner"
        aria-label="Menüleiste einblenden"
        onClick={() => setRevealTick((t) => t + 1)}
      />
    );
  }

  const showPicker = pickerOpen && editMode;
  const showRemote = remoteOpen && editMode;
  const canEdit = allowLocalEditing || editMode;
  const customName = kioskName && kioskName !== 'SlateDesk' ? kioskName : null;

  return (
    <div
      className={`topbar${revealed ? ' overlay' : ''}`}
      onPointerDown={revealed ? () => setRevealTick((t) => t + 1) : undefined}
    >
      <div className="topbar-left">
        <span className="topbar-logo">SLATEDESK</span>
        {customName && <span className="topbar-name">{customName}</span>}
      </div>
      <div className="topbar-right">
        {isTauri() && <UpdateButton updater={updater} />}
        <button
          type="button"
          className="topbar-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Helles Design' : 'Dunkles Design'}
          aria-label={theme === 'dark' ? 'Helles Design einschalten' : 'Dunkles Design einschalten'}
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        {editMode && isTauri() && (
          <button type="button" className="topbar-btn" onClick={() => setRemoteOpen(true)} title="Fernsteuerung im Browser">
            <Smartphone size={16} />
            Fernsteuerung
          </button>
        )}
        {editMode && (
          <button
            ref={pickerButtonRef}
            type="button"
            className={`topbar-btn${showPicker ? ' active' : ''}`}
            onClick={() => setPickerOpen((open) => !open)}
            aria-expanded={showPicker}
            title="Widget hinzufügen"
          >
            <Plus size={16} />
            Widget
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className={`topbar-btn${editMode ? ' active' : ''}`}
            onClick={() => {
              setPickerOpen(false);
              setEditMode(!editMode);
            }}
            title="Layout bearbeiten"
          >
            {editMode ? <Check size={16} /> : <Settings size={16} />}
            {editMode ? 'Fertig' : 'Bearbeiten'}
          </button>
        )}
      </div>
      {showPicker && <WidgetPicker onClose={closePicker} anchorRef={pickerButtonRef} />}
      {showRemote && <RemoteInfoDialog onClose={closeRemote} />}
    </div>
  );
};
