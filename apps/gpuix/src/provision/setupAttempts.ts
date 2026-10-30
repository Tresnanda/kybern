import type { ProjectsProvisionParams, ProvisionPlan, ProvisionStatus } from '../../../../packages/kybern-client/src/types.ts'

export interface SetupAttempt {
  request: ProjectsProvisionParams
  plan: ProvisionPlan
  status: ProvisionStatus | null
  error: string
}

/** Sheets can close while an outbox item waits offline. Reopening must resume that item and its exact consent. */
export class SetupAttempts {
  private attempts = new Map<string, SetupAttempt>()
  key(source: string, project: string, target: string) { return JSON.stringify([source, project, target]) }
  get(key: string) { return this.attempts.get(key) }
  remember(key: string, attempt: SetupAttempt) {
    if (!this.attempts.has(key) && this.attempts.size >= 128) {
      const settled = [...this.attempts].find(([, item]) => item.status && ['done', 'failed', 'cancelled'].includes(item.status.phase))
      if (settled) this.attempts.delete(settled[0])
      else throw new Error('There are too many pending project setups. Finish one before adding another.')
    }
    this.attempts.set(key, attempt)
  }
  forget(key: string) { this.attempts.delete(key) }
}

export const setupAttempts = new SetupAttempts()
