/** useKioskName – state.kiosk.name once the state is loaded, before that the name from /api/auth/status. */
import { useAppState } from '../../state/appState';
import { useSession } from '../session';

export function useKioskName(): string {
  const ready = useAppState((s) => s.ready);
  const stateName = useAppState((s) => s.state.kiosk.name);
  const sessionName = useSession((s) => s.name);
  const name = ready ? stateName.trim() : '';
  return name || sessionName;
}
