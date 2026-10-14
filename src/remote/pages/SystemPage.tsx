/**
 * System: device details, update with progress, actions (reload, identify,
 * display, restart), PIN change, backup/restore and logout.
 */
import { UserRound } from 'lucide-react';
import { LogoutButton } from '../components/LogoutButton';
import { useSystemInfo } from '../hooks/useSystemInfo';
import { Card, PageHeader } from '../ui';
import { ActionsCard } from './system/ActionsCard';
import { BackupCard } from './system/BackupCard';
import { DeviceCard } from './system/DeviceCard';
import { PinCard } from './system/PinCard';
import { UpdateCard } from './system/UpdateCard';

const SYSTEM_POLL_MS = 15_000;

export function SystemPage() {
  const system = useSystemInfo(SYSTEM_POLL_MS);
  return (
    <div className="r-page">
      <PageHeader title="System" description="Geräteinfo, Updates, Neustart, PIN und Sicherung" />
      <DeviceCard poll={system} />
      <UpdateCard info={system.data} />
      <ActionsCard />
      <PinCard />
      <BackupCard />
      <Card title="Sitzung" icon={UserRound} subtitle="Meldet diesen Browser von der Fernsteuerung ab.">
        <div className="r-form-actions r-form-actions-start">
          <LogoutButton />
        </div>
      </Card>
    </div>
  );
}
