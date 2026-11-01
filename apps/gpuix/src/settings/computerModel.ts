// Settings › Computer use: the pure decisions (platform words, which driver, driver copy, note keys), kept apart from the
// view so tests can simulate each OS and an older daemon that sends no `platform`, `driver` or `drivers`.
import type { ComputerDriver, ComputerNote, ComputerStatus } from '../../../../packages/kybern-client/src/types.ts'
import { osName, type OsName } from '../platform/os.ts'

/** The daemon machine's OS: from status, else this client's own (an older daemon sends no platform). */
export function computerOs(status: Pick<ComputerStatus, 'platform'> | null, local: NodeJS.Platform = process.platform): OsName {
  const named = status?.platform
  return named === 'macos' || named === 'windows' || named === 'linux' ? named : osName(local)
}

/** "this Mac", "this PC", "this computer" in a sentence. */
export function thisComputer(os: OsName): string {
  return os === 'macos' ? 'this Mac' : os === 'windows' ? 'this PC' : 'this computer'
}

/** The drivers this machine offers, the default first. Older daemons send none: macOS then has CuaDriver only. */
export function offeredDrivers(status: Pick<ComputerStatus, 'drivers'> | null, os: OsName): ComputerDriver[] {
  if (status?.drivers?.length) return status.drivers
  return os === 'macos' ? ['cua_driver'] : ['agent_desktop']
}

/** The driver in use: the status says, else the setting if this machine offers it, else the OS default. */
export function activeDriver(status: Pick<ComputerStatus, 'driver' | 'drivers'> | null, os: OsName, setting?: ComputerDriver | null): ComputerDriver {
  if (status?.driver) return status.driver
  const offered = offeredDrivers(status, os)
  return setting && offered.includes(setting) ? setting : offered[0]
}

export const DRIVER_NAME: Record<ComputerDriver, string> = { cua_driver: 'CuaDriver', agent_desktop: 'agent-desktop' }

/** The Select's value when more than one driver is offered; the default (first) is the empty setting. */
export const driverSetting = (choice: ComputerDriver, offered: ComputerDriver[]): ComputerDriver | null => (choice === offered[0] ? null : choice)

export const PANE_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
export const PANE_SCREEN = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/** The driver row's hint, in plain words: the choice belongs to this machine alone. */
export function driverHint(os: OsName, selectable: boolean): string {
  const where = thisComputer(os)
  return selectable
    ? `Chosen for ${where} only. Other machines keep their own. Applies to new conversations.`
    : `The program Kybern uses to see and control apps on ${where}.`
}

/** Notes are keyed by the app id when the daemon sends one, else by the old bundle id. */
export const noteKey = (note: Pick<ComputerNote, 'app_id' | 'bundle_id'>): string => note.app_id ?? note.bundle_id

/** Checks that already have a row of their own on macOS; everything else is a "problem" row. Off macOS nothing is hidden. */
export const OWN_ROW_CHECKS = ['installed', 'enabled', 'version', 'signature', 'accessibility', 'screen_recording']

const CHECK_TITLES: Record<string, string> = { uia: 'UI Automation', 'at-spi': 'Accessibility bus (AT-SPI)', at_spi: 'Accessibility bus (AT-SPI)', portal: 'Screenshot portal', integrity: 'Integrity level', session: 'Display session' }
/** A doctor check's row title: a known name in words, else the daemon's name in sentence case. */
export function checkTitle(name: string): string {
  return CHECK_TITLES[name.toLowerCase()] ?? name.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
