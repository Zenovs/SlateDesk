import { Moon, Sun, SunMoon } from 'lucide-react';
import { resolveTheme, setThemePreference, toggleTheme, useRemoteTheme, type ThemePreference } from '../theme';
import { Button, Segmented, type SegmentedOption } from '../ui';

const PREFERENCE_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'Automatisch', icon: SunMoon },
  { value: 'light', label: 'Hell', icon: Sun },
  { value: 'dark', label: 'Dunkel', icon: Moon },
];

/** Narrow variant for the sidebar. */
const COMPACT_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Hell' },
  { value: 'dark', label: 'Dunkel' },
];

/** Icon button: switches the web UI between light and dark. */
export function ThemeToggle() {
  const theme = useRemoteTheme(resolveTheme);
  return (
    <Button variant="ghost" className="r-theme-toggle" iconOnly icon={theme === 'dark' ? Sun : Moon} onClick={toggleTheme}>
      {theme === 'dark' ? 'Helle Darstellung' : 'Dunkle Darstellung'}
    </Button>
  );
}

/** Automatisch / Hell / Dunkel for the web UI (this browser only). */
export function ThemeChooser({ block = false, compact = false }: { block?: boolean; compact?: boolean }) {
  const preference = useRemoteTheme((s) => s.preference);
  return (
    <Segmented
      label="Darstellung der Fernsteuerung"
      value={preference}
      options={compact ? COMPACT_OPTIONS : PREFERENCE_OPTIONS}
      onChange={setThemePreference}
      block={block}
    />
  );
}
