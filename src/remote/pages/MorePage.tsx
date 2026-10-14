/** «Mehr» (phones): the remaining pages, appearance of the web UI and logout. */
import { ChevronRight, Palette, UserRound } from 'lucide-react';
import { LogoutButton } from '../components/LogoutButton';
import { ThemeChooser } from '../components/ThemeControls';
import { useKioskName } from '../hooks/useKioskName';
import { MORE_NAV } from '../nav';
import { href } from '../router';
import { Card, PageHeader } from '../ui';

export function MorePage() {
  const name = useKioskName();
  return (
    <div className="r-page">
      <PageHeader title="Mehr" />

      <nav className="r-list" aria-label="Weitere Bereiche">
        {MORE_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <a key={item.route} className="r-list-item" href={href(item.route)}>
              <span className="r-list-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
              <span className="r-list-text">
                <span className="r-list-title">{item.label}</span>
                <span className="r-list-subtitle">{item.description}</span>
              </span>
              <ChevronRight className="r-list-chevron" size={18} aria-hidden="true" />
            </a>
          );
        })}
      </nav>

      <Card title="Darstellung" icon={Palette} subtitle="Gilt nur für diesen Browser. Das Design des Kiosks wird unter «Kiosk» eingestellt.">
        <ThemeChooser block />
      </Card>

      <Card title="Sitzung" icon={UserRound} subtitle={`Angemeldet bei «${name}»`}>
        <LogoutButton block />
      </Card>
    </div>
  );
}
