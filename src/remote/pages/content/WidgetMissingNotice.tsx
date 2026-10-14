import { LayoutGrid } from 'lucide-react';
import { useAppState } from '../../../state/appState';
import { getManifest } from '../../../widgets/catalog';
import { href } from '../../router';
import { LinkButton, Notice } from '../../ui';

export interface WidgetMissingNoticeProps {
  widgetId: string;
  /** Plural subject of the sentence, e.g. «Mitteilungen». */
  subject: string;
}

/** Hint (with a link to the layout) while no widget on the kiosk shows this content. */
export function WidgetMissingNotice({ widgetId, subject }: WidgetMissingNoticeProps) {
  const placed = useAppState((s) => s.state.layout.widgets.some((w) => w.widgetId === widgetId));
  if (placed) return null;
  const name = getManifest(widgetId)?.name ?? widgetId;
  return (
    <Notice
      tone="info"
      title={`Kein Widget «${name}» auf dem Kiosk`}
      action={
        <LinkButton href={href('layout')} size="sm" icon={LayoutGrid}>
          Zum Layout
        </LinkButton>
      }
    >
      {subject} erscheinen auf dem Kiosk erst, wenn dort ein Widget «{name}» platziert ist.
    </Notice>
  );
}
