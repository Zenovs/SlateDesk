import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { errorText } from '../errors';
import { logout } from '../session';
import { Button, toast } from '../ui';

/** Ends the session on the kiosk and returns to the login page. */
export function LogoutButton({ block = false, variant = 'secondary' }: { block?: boolean; variant?: 'secondary' | 'ghost' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      icon={LogOut}
      block={block}
      busy={busy}
      onClick={() => {
        setBusy(true);
        // Success reloads the page.
        logout().catch((err: unknown) => {
          setBusy(false);
          toast.error(`Abmelden fehlgeschlagen: ${errorText(err)}`);
        });
      }}
    >
      Abmelden
    </Button>
  );
}
