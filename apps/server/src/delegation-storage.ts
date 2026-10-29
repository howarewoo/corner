import { AsyncLocalStorage } from 'node:async_hooks';
import { and, eq, or, isNull, sql } from 'drizzle-orm';
import type { Adapter, AdapterPayload } from 'oidc-provider';
import type Provider from 'oidc-provider';
import type { Principal } from './auth.js';
import type { Transaction } from './queries.js';
import { delegationObjects } from './delegation-schema.js';

export type DelegationTransaction = {
  tx: Transaction;
  principal: Principal | null;
  handledError: boolean;
  securityRevoked: boolean;
  serverFailure: boolean;
};

export const delegationTransaction = new AsyncLocalStorage<DelegationTransaction>();

export function currentDelegationTransaction() {
  const state = delegationTransaction.getStore();
  if (!state) throw new Error('Delegation storage requires a request transaction');
  return state;
}

export async function lockDelegatedGrant(tx: Transaction, grantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${grantId}, 934572))`);
}

const active = () =>
  or(isNull(delegationObjects.expiresAt), sql`${delegationObjects.expiresAt} > clock_timestamp()`);

/** Supported oidc-provider adapter; protocol decisions remain exclusively in the issuer. */
export class DelegationAdapter implements Adapter {
  constructor(private readonly model: string) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    const { tx, principal } = currentDelegationTransaction();
    const expiresAt =
      typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null;
    const grantId = payload.grantId ?? null;
    const clientId = typeof payload.clientId === 'string' ? payload.clientId : null;
    await tx
      .insert(delegationObjects)
      .values({
        model: this.model,
        id,
        payload,
        grantId,
        clientId,
        ownerId: this.model === 'Interaction' ? principal?.userId : payload.accountId,
        managedSessionId: this.model === 'Interaction' ? principal?.sessionId : null,
        managedSessionExpiresAt:
          this.model === 'Interaction' && principal?.managedSession
            ? new Date(principal.managedSession.expiresAt)
            : null,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [delegationObjects.model, delegationObjects.id],
        // Consent provenance is insert-only; a new managed session cannot take over a pending interaction.
        set: { payload, grantId, clientId, expiresAt },
      });
  }

  async find(id: string) {
    const { tx } = currentDelegationTransaction();
    const where = and(
      eq(delegationObjects.model, this.model),
      eq(delegationObjects.id, id),
      active(),
    );
    let [row] = await tx
      .select({ payload: delegationObjects.payload })
      .from(delegationObjects)
      .where(where)
      .limit(1);
    const grantId = this.model === 'Grant' ? id : row?.payload.grantId;
    if (grantId) {
      // Read again after locking: replay and owner revocation serialize on this grant only.
      await lockDelegatedGrant(tx, grantId);
      [row] = await tx
        .select({ payload: delegationObjects.payload })
        .from(delegationObjects)
        .where(where)
        .limit(1)
        .for('update');
    }
    return row?.payload;
  }

  private async findBy(field: 'uid' | 'userCode', value: string) {
    const { tx } = currentDelegationTransaction();
    const [row] = await tx
      .select({ id: delegationObjects.id })
      .from(delegationObjects)
      .where(
        and(
          eq(delegationObjects.model, this.model),
          sql`${delegationObjects.payload}->>${field} = ${value}`,
          active(),
        ),
      )
      .limit(1);
    return row ? this.find(row.id) : undefined;
  }

  findByUid(uid: string) {
    return this.findBy('uid', uid);
  }
  findByUserCode(userCode: string) {
    return this.findBy('userCode', userCode);
  }

  async destroy(id: string) {
    const { tx } = currentDelegationTransaction();
    await tx
      .delete(delegationObjects)
      .where(and(eq(delegationObjects.model, this.model), eq(delegationObjects.id, id)));
  }

  async consume(id: string) {
    const { tx } = currentDelegationTransaction();
    await tx
      .update(delegationObjects)
      .set({
        payload: sql`jsonb_set(${delegationObjects.payload}, '{consumed}', to_jsonb(floor(extract(epoch from clock_timestamp()))::bigint))`,
      })
      .where(and(eq(delegationObjects.model, this.model), eq(delegationObjects.id, id)));
  }

  async revokeByGrantId(grantId: string) {
    const { tx } = currentDelegationTransaction();
    await lockDelegatedGrant(tx, grantId);
    await tx
      .delete(delegationObjects)
      .where(and(eq(delegationObjects.model, this.model), eq(delegationObjects.grantId, grantId)));
  }
}

/** Documented semantic events, never HTTP status/error-string inference, control rollback. */
export function bindDelegationTransactionEvents(issuer: Provider) {
  const handledError = () => {
    const state = delegationTransaction.getStore();
    if (state) state.handledError = true;
  };
  issuer.on('grant.error', handledError);
  issuer.on('authorization.error', handledError);
  issuer.on('revocation.error', handledError);
  issuer.on('registration_create.error', handledError);
  issuer.on('grant.revoked', () => {
    const state = delegationTransaction.getStore();
    if (state) state.securityRevoked = true;
  });
  issuer.on('server_error', () => {
    const state = delegationTransaction.getStore();
    if (state) state.serverFailure = true;
  });
}
