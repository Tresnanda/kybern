import type {
  ProviderInstance,
  ProviderStatus,
  ProjectId,
} from "../../../../packages/kybern-client/src/types.ts"

export interface AccountRequestScope {
  threadId: string
  environmentId: string | null
  settings: unknown
}
interface AccountRequestToken {
  scope: AccountRequestScope
  revision: number
}

/** Target hydration cannot overtake an in-flight explicit selection. */
export class AccountRequestSequence {
  private scope: AccountRequestScope | null = null
  private revision = 0
  private pendingSelection: number | null = null

  private enter(scope: AccountRequestScope) {
    if (
      this.scope?.threadId === scope.threadId &&
      this.scope.environmentId === scope.environmentId &&
      this.scope.settings === scope.settings
    )
      return
    this.scope = scope
    this.pendingSelection = null
    this.revision++
  }
  select(scope: AccountRequestScope): AccountRequestToken {
    this.enter(scope)
    this.pendingSelection = ++this.revision
    return { scope, revision: this.revision }
  }
  read(scope: AccountRequestScope): AccountRequestToken | null {
    this.enter(scope)
    if (this.pendingSelection !== null) return null
    return { scope, revision: ++this.revision }
  }
  accepts(token: AccountRequestToken): boolean {
    return (
      this.revision === token.revision &&
      this.scope?.threadId === token.scope.threadId &&
      this.scope.environmentId === token.scope.environmentId &&
      this.scope.settings === token.scope.settings
    )
  }
  finish(token: AccountRequestToken): boolean {
    if (!this.accepts(token)) return false
    if (this.pendingSelection === token.revision) this.pendingSelection = null
    return true
  }
}

/** Named-account composers refresh their account; other composers retain their probe. */
export async function refreshComposerCatalog(
  provider: ProviderInstance,
  projectId: ProjectId | undefined,
  forceRefresh: boolean,
  refreshAccount:
    | ((
        provider: ProviderInstance,
        force: boolean
      ) => Promise<ProviderStatus | undefined>)
    | undefined,
  refreshProviders: (projectId?: ProjectId) => Promise<ProviderStatus[]>
): Promise<ProviderStatus | undefined> {
  if (refreshAccount) return refreshAccount(provider, forceRefresh)
  return (await refreshProviders(projectId)).find(
    (status) => status.kind === provider.kind
  )
}
