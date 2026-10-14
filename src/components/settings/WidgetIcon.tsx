/**
 * WidgetIcon – renders a manifest's `icon` (lucide-react name).
 *
 * Lives next to SettingsForm because the web UI may import it as well.
 * Unknown names fall back to a grid icon; the known ones are listed in
 * widgetIcons.ts.
 */
import { LayoutGrid, type LucideProps } from 'lucide-react';
import { WIDGET_ICONS } from './widgetIcons';

interface WidgetIconProps extends Omit<LucideProps, 'ref'> {
  name?: string;
}

export function WidgetIcon({ name, ...props }: WidgetIconProps) {
  const Icon = (name && WIDGET_ICONS[name]) || LayoutGrid;
  return <Icon aria-hidden="true" {...props} />;
}
