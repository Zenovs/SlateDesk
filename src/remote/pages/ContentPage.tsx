/**
 * Inhalte: Pinnwand (announcements) and Aufgaben (todos) – the content the
 * kiosk's widgets show. The chosen tab is remembered per browser.
 */
import { useId } from 'react';
import { ListTodo, Megaphone } from 'lucide-react';
import { useAppState } from '../../state/appState';
import { useLocalChoice } from '../hooks/useLocalChoice';
import { PageHeader, TabPanel, Tabs, type TabItem } from '../ui';
import { AnnouncementsPanel } from './content/AnnouncementsPanel';
import { TodosPanel } from './content/TodosPanel';

type ContentTab = 'pinnwand' | 'aufgaben';

const TAB_KEY = 'slatedesk-remote:content-tab';
const TAB_VALUES = ['pinnwand', 'aufgaben'] as const;

export function ContentPage() {
  const idPrefix = useId();
  const [tab, setTab] = useLocalChoice<ContentTab>(TAB_KEY, TAB_VALUES, 'pinnwand');
  const announcementCount = useAppState((s) => Object.keys(s.state.data.announcements).length);
  const openTodos = useAppState((s) => Object.values(s.state.data.todos).filter((todo) => !todo.done).length);

  const tabs: TabItem<ContentTab>[] = [
    {
      value: 'pinnwand',
      label: 'Pinnwand',
      icon: Megaphone,
      count: announcementCount,
      countLabel: `${announcementCount} ${announcementCount === 1 ? 'Mitteilung' : 'Mitteilungen'}`,
    },
    { value: 'aufgaben', label: 'Aufgaben', icon: ListTodo, count: openTodos, countLabel: `${openTodos} offen` },
  ];

  return (
    <div className="r-page">
      <PageHeader title="Inhalte" description="Mitteilungen und Aufgaben für den Kiosk – Änderungen erscheinen dort sofort." />
      <Tabs label="Inhalte" idPrefix={idPrefix} value={tab} items={tabs} onChange={setTab} />
      <TabPanel idPrefix={idPrefix} value="pinnwand" active={tab === 'pinnwand'}>
        <AnnouncementsPanel />
      </TabPanel>
      <TabPanel idPrefix={idPrefix} value="aufgaben" active={tab === 'aufgaben'}>
        <TodosPanel />
      </TabPanel>
    </div>
  );
}
