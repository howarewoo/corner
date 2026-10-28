import { useRef, useState } from 'react';
import type { AppState, Settings as WorkspaceSettings } from '@packages/workspace/types';
import { rpc, scoped, sessionLifetime } from '../../rpc';
import { dateKey } from '@packages/nutrition/dates';
import { ArrowDownToLine, LogOut } from 'lucide-react';
import { Button, WorkspaceHeader } from '@packages/ui';
import ProfileForm from '../../profile-form';
import ImportWorkspace from '../../import-workspace';
import type { Mutate, Notify } from '../workspace/types';
import { download } from '../workspace/utils';

export default function Settings({
  state,
  settings,
  disabled,
  busy,
  preview,
  accountEmail,
  signingOut,
  onSignOut,
  notify,
  mutate,
}: {
  state?: AppState;
  settings: WorkspaceSettings;
  disabled: boolean;
  busy: boolean;
  preview: boolean;
  accountEmail?: string;
  signingOut?: boolean;
  onSignOut?: () => void;
  notify: Notify;
  mutate: Mutate;
}) {
  const generation = useRef(sessionLifetime()).current;
  const exportLock = useRef(false);
  const [exporting, setExporting] = useState(false);
  const currentDate = dateKey(new Date(), settings.timezone);
  const exportWorkspace = async () => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    try {
      const snapshot = state ?? (await scoped(() => rpc.workspace.export(), generation)).state;
      if (!preview && generation !== sessionLifetime()) return;
      download(JSON.stringify(snapshot), `corner-data-${currentDate}.json`, 'application/json');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not export your workspace.', true);
    } finally {
      exportLock.current = false;
      setExporting(false);
    }
  };
  return (
    <>
      <WorkspaceHeader
        title="Your starting point."
        eyebrow="MAKE IT YOURS"
        description="Targets that fit your routine, with room to adjust as you go."
        actions={
          <>
            <Button
              variant="outline"
              size="default"
              disabled={exporting}
              onClick={() => void exportWorkspace()}
            >
              <ArrowDownToLine size={16} />
              {exporting ? 'Exporting…' : 'Export workspace'}
            </Button>
            {onSignOut && (
              <Button variant="outline" disabled={signingOut || busy} onClick={onSignOut}>
                <LogOut size={15} />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </Button>
            )}
          </>
        }
      />
      <p className="profile-help">Signed in as {accountEmail}</p>
      <p className="profile-help" style={{ marginBottom: 24 }}>
        Workspace exports include recipes, plans, food and training logs, your profile, and
        supported historical requests and reviews. They are not complete installation backups.
      </p>
      <ProfileForm
        key={JSON.stringify(settings)}
        settings={settings}
        busy={disabled}
        onSave={(settings) =>
          mutate({ type: 'settings.save', data: settings }, 'Your profile is saved')
        }
      />
      <ImportWorkspace
        disabled={disabled || preview}
        onImported={() => notify('Your workspace is imported')}
      />
    </>
  );
}
