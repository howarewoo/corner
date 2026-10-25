import type { AppState } from '@packages/workspace/types';
import { dateKey } from '@packages/nutrition/dates';
import { ArrowDownToLine, LogOut } from 'lucide-react';
import { Button, WorkspaceHeader } from '@packages/ui';
import ProfileForm from '../../profile-form';
import ImportWorkspace from '../../import-workspace';
import { AgentConnection } from '../../agent-panel';
import type { Mutate, Notify } from '../workspace/types';
import { download } from '../workspace/utils';

export default function Settings({
  state,
  revision,
  disabled,
  busy,
  preview,
  accountEmail,
  signingOut,
  onSignOut,
  notify,
  readState,
  mutate,
}: {
  state: AppState;
  revision: number;
  disabled: boolean;
  busy: boolean;
  preview: boolean;
  accountEmail?: string;
  signingOut?: boolean;
  onSignOut?: () => void;
  notify: Notify;
  readState: () => Promise<void>;
  mutate: Mutate;
}) {
  const currentDate = dateKey(new Date(), state.settings.timezone);
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
              onClick={() =>
                download(
                  JSON.stringify(state, null, 2),
                  `corner-data-${currentDate}.json`,
                  'application/json',
                )
              }
            >
              <ArrowDownToLine size={16} />
              Export workspace
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
        Workspace exports include recipes, plans, food and training logs, and your profile. Agent
        request history is not included.
      </p>
      <ProfileForm
        key={revision}
        settings={state.settings}
        busy={disabled}
        onSave={(settings) =>
          mutate({ type: 'settings.save', data: settings }, 'Your profile is saved')
        }
      />
      <ImportWorkspace
        disabled={disabled || preview}
        onImported={() => notify('Your workspace is imported')}
      />
      <div style={{ marginTop: 32 }}>
        <AgentConnection onChanged={() => void readState()} compact />
      </div>
    </>
  );
}
