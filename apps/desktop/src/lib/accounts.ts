// Pure account helpers: colors, names, sign-in routing and the Add account
// sheet's step logic. No React and no `@/` imports, so node tests load it directly.

import type {
  AccountLogin,
  AccountLoginMode,
  AccountSummary,
  ProviderAccount,
  ProviderKind,
  ProviderSettings,
} from "../../../../packages/kybern-client/src/types.ts"

/** Palette keys in assignment order. Red and orange are left out on purpose. */
export const ACCOUNT_COLORS = ["blue", "green", "purple", "pink", "teal", "amber"] as const
export type AccountColor = (typeof ACCOUNT_COLORS)[number]

export const ACCOUNT_COLOR_LABELS: Record<AccountColor, string> = {
  blue: "Blue",
  green: "Green",
  purple: "Purple",
  pink: "Pink",
  teal: "Teal",
  amber: "Amber",
}

/** The implicit instance: the sign-in the agent's own CLI uses. */
export const CLI_INSTANCE = "default"
export const CLI_ACCOUNT_NAME = "CLI account"

export function isAccountColor(value: unknown): value is AccountColor {
  return typeof value === "string" && (ACCOUNT_COLORS as readonly string[]).includes(value)
}

/** CSS color for a palette key, or null when the key is unknown (no dot is drawn). */
export function accountColorVar(color: string | null | undefined): string | null {
  return isAccountColor(color) ? `var(--account-${color})` : null
}

/**
 * The first palette key no other account of the agent uses. Once all six are
 * taken the palette cycles from the start.
 */
export function nextFreeColor(used: readonly (string | null | undefined)[]): AccountColor {
  const taken = new Set(used.filter(isAccountColor))
  const free = ACCOUNT_COLORS.find((color) => !taken.has(color))
  if (free) return free
  return ACCOUNT_COLORS[used.length % ACCOUNT_COLORS.length]!
}

export function isCliInstance(instance: string | null | undefined): boolean {
  return !instance || instance === CLI_INSTANCE
}

/** "CLI account" for the implicit instance, otherwise the account's own name. */
export function accountDisplayName(instance: string | null | undefined, name?: string | null): string {
  if (isCliInstance(instance)) return CLI_ACCOUNT_NAME
  return name?.trim() || "Account unavailable"
}

export function accountFor(
  accounts: readonly AccountSummary[],
  kind: ProviderKind,
  instance: string | null | undefined,
): AccountSummary | undefined {
  const wanted = instance || CLI_INSTANCE
  return accounts.find((account) => account.provider.kind === kind && account.provider.instance === wanted)
}

/** The account that new threads of this agent use. */
export function defaultAccountFor(accounts: readonly AccountSummary[], kind: ProviderKind): AccountSummary | undefined {
  const ofKind = accounts.filter((account) => account.provider.kind === kind)
  return ofKind.find((account) => account.is_default) ?? ofKind.find((account) => isCliInstance(account.provider.instance))
}

/**
 * Accounts of an older daemon, built from settings alone: the CLI account with
 * an unknown status, then named accounts in settings order. Nothing here can
 * sign in, sign out or remove; the sheet falls back to the legacy terminal.
 */
export function legacyAccounts(
  providers: Partial<Record<ProviderKind, ProviderSettings>> | undefined,
  kinds: readonly ProviderKind[],
): AccountSummary[] {
  const result: AccountSummary[] = []
  for (const kind of kinds) {
    const settings = providers?.[kind]
    const named: [string, ProviderAccount][] = Object.entries(settings?.accounts ?? {})
    const defaultInstance = settings?.default_account || CLI_INSTANCE
    const projectsFor = (instance: string) =>
      Object.entries(settings?.project_accounts ?? {})
        .filter(([, account]) => account === instance)
        .map(([path]) => path)
    result.push({
      provider: { kind, instance: CLI_INSTANCE },
      name: CLI_ACCOUNT_NAME,
      status: "unknown",
      is_default: defaultInstance === CLI_INSTANCE,
      projects: projectsFor(CLI_INSTANCE),
      managed: false,
      can_sign_out: false,
    })
    for (const [instance, account] of named) {
      result.push({
        provider: { kind, instance },
        name: account.name,
        ...(account.color ? { color: account.color } : {}),
        ...(account.email || account.plan ? { identity: { ...(account.email ? { email: account.email } : {}), ...(account.plan ? { plan: account.plan } : {}) } } : {}),
        status: "unknown",
        is_default: defaultInstance === instance,
        projects: projectsFor(instance),
        directory: account.directory,
        managed: false,
        can_sign_out: false,
      })
    }
  }
  return result
}

// ── Sign-in routing ──────────────────────────────────────────────────────────

/** Agents whose sign-in can happen in the user's browser. */
export function supportsBrowserLogin(kind: ProviderKind): boolean {
  return kind === "claude-code" || kind === "codex" || kind === "cursor" || kind === "omp"
}
/** Agents whose sign-in page shows a code to paste back. */
export function supportsPasteCode(kind: ProviderKind): boolean {
  return kind === "claude-code" || kind === "omp"
}
/** Agents with a one-time code to enter on a sign-in page. */
export function supportsDeviceCode(kind: ProviderKind): boolean {
  return kind === "codex"
}

/**
 * How a new sign-in starts. The client decides, because the daemon cannot tell
 * a tunnelled client from a local one. On a remote daemon the browser cannot
 * return to the machine, so claude and omp paste a code and codex uses a
 * device code. Cursor's page polls, so it keeps the browser.
 */
export function initialLoginMode(kind: ProviderKind, remote: boolean): AccountLoginMode {
  if (kind === "opencode" || kind === "pi") return "terminal"
  if (!remote) return "browser"
  if (supportsPasteCode(kind)) return "paste"
  if (supportsDeviceCode(kind)) return "device_code"
  return "browser"
}

export type Transport = "SSH" | "Tailscale"

export function remoteNote(host: string, transport: Transport): string {
  return `Kybern is connected to ${host} over ${transport}, so the browser can't return to it directly.`
}

// ── Sheet steps ──────────────────────────────────────────────────────────────

export type SheetStep = "pick" | "waiting" | "paste" | "device" | "terminal" | "success" | "duplicate" | "error"

/** The step a login shows. `null` means the sheet has nothing to show for it (canceled). */
export function stepFor(login: AccountLogin | null): SheetStep | null {
  if (!login) return "pick"
  switch (login.phase) {
    case "signed_in":
      return login.duplicate_of ? "duplicate" : "success"
    case "failed":
      return "error"
    case "canceled":
      return null
    case "starting":
    case "waiting":
    case "verifying":
      switch (login.mode) {
        case "paste":
          return "paste"
        case "device_code":
          return "device"
        case "terminal":
          return "terminal"
        case "browser":
          return "waiting"
      }
  }
}

/** A login that still has a process or staging folder behind it. */
export function isLoginLive(login: AccountLogin | null): boolean {
  return !!login && (login.phase === "starting" || login.phase === "waiting" || login.phase === "verifying" || login.phase === "signed_in")
}

/** A finished login that was never saved. Closing the sheet on it saves it. */
export function shouldFinishOnClose(login: AccountLogin | null): boolean {
  return !!login && login.phase === "signed_in" && !login.duplicate_of && !login.instance
}

/** Prefilled values for the success step. */
export function successDefaults(login: AccountLogin, used: readonly (string | null | undefined)[]): { name: string; color: AccountColor } {
  const suggested = login.suggested_color
  return {
    name: login.suggested_name?.trim() || "New account",
    color: isAccountColor(suggested) && !used.includes(suggested) ? suggested : nextFreeColor(used),
  }
}

/** Mode to retry or continue in when the user picks a different way to sign in. */
export type LoginSwitch = "paste" | "device_code" | "terminal"

export function loginSwitchOptions(kind: ProviderKind, remote: boolean): LoginSwitch[] {
  const options: LoginSwitch[] = []
  if (!remote && supportsPasteCode(kind)) options.push("paste")
  if (!remote && supportsDeviceCode(kind)) options.push("device_code")
  options.push("terminal")
  return options
}

export function isNameValid(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= 120
}
