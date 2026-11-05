// What a Problem's buttons do. `describeProblem` names an action by id (`packages/kybern-client/src/problems.ts`); this table maps each id
// onto a flow GPUIX already has, so a button never invents a new one. An id that isn't here, or that cannot run with the context it was
// given (no `retry` to call, no detail to copy), renders no button. The heavy flows load on the click, so importing the table is free.
import type { ProblemViewAction } from '../../../../packages/kybern-client/src/problems.ts'
import type { ProblemButton } from '../kit/Problem.tsx'
import { writeClipboardText } from '../platform/os.ts'
import { installPlan, providerOf } from './install.ts'

/** What the surface that shows a problem knows about it. */
export interface ActionContext {
  /** The project whose machine the fix runs on; absent means this computer. */
  projectId?: string
  /** Does the thing again (a refresh, a resend). Without it `retry` renders no button. */
  retry?: () => void
  /** The technical text `copy_details` copies. Without it that action renders no button. */
  detail?: string
  /** Runs when a fix that opened a terminal closes, to check again. Defaults to `retry`. */
  done?: () => void
}

export interface ProblemActionHandler {
  /** Whether this action can run with `context`; `false` renders no button. */
  available(action: ProblemViewAction, context: ActionContext): boolean
  run(action: ProblemViewAction, context: ActionContext): void
}

const text = (action: ProblemViewAction, key: string): string | undefined => {
  const value = action.params?.[key]
  return typeof value === 'string' && value ? value : undefined
}
const done = (context: ActionContext) => context.done ?? context.retry ?? (() => {})

/** The fix would run on a computer that can't be reached: say so, since the terminal can't open. */
async function unreachable() {
  const { toast } = await import('../shell/toasts.tsx')
  toast.problem('That computer is offline', { tone: 'neutral', icon: 'offline', description: 'Try again when it is back.' })
}

const installTool: ProblemActionHandler = {
  available: (action) => {
    // Whether Kybern knows any way to install it; which way (a command here, a page for a remote machine) is decided when it runs.
    const tool = text(action, 'tool')
    return !!tool && installPlan(tool, true) !== null
  },
  run: (action, context) => {
    const tool = text(action, 'tool')
    if (!tool) return
    const projectId = context.projectId ?? ''
    void (async () => {
      const setup = await import('../pulls/ghSetup.ts')
      const machine = setup.machineFor(projectId)
      const plan = installPlan(tool, machine.local)
      if (!plan) return
      if (plan.kind === 'command' && !machine.client) return unreachable()
      if (plan.kind === 'page') return void (await import('../settings/external.ts')).openExternal(plan.url).catch(() => {})
      if (plan.kind === 'cursor') return void (await import('../onboarding/agentsStore.ts')).cursorSetup('install')
      setup.runInSetupSheet(projectId, plan.title, plan.command, done(context))
    })().catch(() => {})
  },
}

const signIn: ProblemActionHandler = {
  available: () => true,
  run: (action, context) => {
    const provider = text(action, 'provider')
    void (async () => {
      if (provider === 'gh') {
        const setup = await import('../pulls/ghSetup.ts')
        return setup.machineFor(context.projectId ?? '').client ? setup.signInGh(context.projectId ?? '', done(context)) : unreachable()
      }
      // A machine that isn't paired is fixed where machines are managed, not with an account.
      if (provider === 'machine') return (await import('../settings/SettingsScreen.tsx')).openSettingsTab('machines')
      const kind = provider ? providerOf(provider) : null
      // The same Add account sheet Settings opens: it runs `useAccountLogin` (browser, pasted code, terminal).
      if (kind) return (await import('../dialogs/store.ts')).showDialog({ kind: 'account', provider: kind })
      ;(await import('../settings/SettingsScreen.tsx')).openSettingsTab('accounts')
    })().catch(() => {})
  },
}

const openSettings: ProblemActionHandler = {
  available: () => true,
  run: (action) => {
    void import('../settings/SettingsScreen.tsx').then(({ TABS, openSettingsTab }) => {
      const section = text(action, 'section') ?? 'general'
      openSettingsTab(TABS.find((tab) => tab[0] === section)?.[0] ?? 'general')
    }).catch(() => {})
  },
}

const retry: ProblemActionHandler = { available: (_, context) => !!context.retry, run: (_, context) => context.retry?.() }

const copyDetails: ProblemActionHandler = {
  available: (_, context) => !!context.detail,
  run: (_, context) => { if (context.detail) void writeClipboardText(context.detail).catch(() => {}) },
}

const update: ProblemActionHandler = {
  available: () => true,
  run: () => {
    void (async () => {
      const { checkForAppUpdate, getAppUpdate, openUpdateDetails } = await import('../platform/update.ts')
      await checkForAppUpdate({ manual: true })
      // This app may already be current (the older Kybern is another computer's), or unable to update itself: About says which.
      if (getAppUpdate().version) openUpdateDetails()
      else (await import('../settings/SettingsScreen.tsx')).openSettingsTab('about')
    })().catch(() => {})
  },
}

/** Every action id a Problem can name. */
export const PROBLEM_ACTIONS: Readonly<Record<string, ProblemActionHandler>> = {
  install_tool: installTool,
  sign_in: signIn,
  open_settings: openSettings,
  open_machines: { available: () => true, run: () => openSettings.run({ id: 'open_settings', label: '', params: { section: 'machines' } }, {}) },
  retry,
  update,
  // `describeProblem` names it `copy_detail`; the issue and the daemon's wire spelling is `copy_details`.
  copy_detail: copyDetails,
  copy_details: copyDetails,
}

/** The button for `action`, or `null` when the id is unknown or cannot run with `context`. */
export function resolveAction(action: ProblemViewAction | undefined, context: ActionContext = {}, testId?: string): ProblemButton | null {
  if (!action) return null
  const handler = Object.hasOwn(PROBLEM_ACTIONS, action.id) ? PROBLEM_ACTIONS[action.id] : undefined
  if (!handler || !handler.available(action, context)) return null
  return { label: action.label, onClick: () => handler.run(action, context), ...(testId ? { testId } : {}) }
}
