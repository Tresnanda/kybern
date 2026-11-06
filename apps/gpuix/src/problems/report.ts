// "Report a problem": the draft GitHub issue for a failure, ready for the review sheet (`dialogs/ReportProblem.tsx`). The text is built and
// redacted here, before anything is shown (`packages/kybern-client/src/report.ts` decides what is removed); nothing leaves the computer until
// the person has read and confirmed it.
import { hostname, release, userInfo } from 'node:os'
import type { ProblemView } from '../../../../packages/kybern-client/src/problems.ts'
import { buildProblemReport, type ProblemReport, type ReportEnvironment, type ReportNames } from '../../../../packages/kybern-client/src/report.ts'

/** "Windows 10.0.26300", "macOS (Darwin 25.1.0)", "Linux 6.8.0": the OS as a person names it, with the kernel's version. */
export function osLabel(platform: string, kernel: string): string {
  if (platform === 'win32') return `Windows ${kernel}`
  if (platform === 'darwin') return `macOS (Darwin ${kernel})`
  if (platform === 'linux') return `Linux ${kernel}`
  return `${platform} ${kernel}`.trim()
}

export interface ReportContext { environment: ReportEnvironment; names: ReportNames }

/** Reads each part on its own: a build without a version, or a daemon that is not connected, still reports. */
export async function reportContext(): Promise<ReportContext> {
  const names: { users: string[]; machines: string[] } = { users: [], machines: [] }
  const environment: ReportEnvironment = { os: osLabel(process.platform, release()), arch: process.arch }
  try { names.users.push(userInfo().username) } catch { /* no account name to remove */ }
  try {
    const host = hostname()
    names.machines.push(host, host.split('.')[0])
  } catch { /* no host name to remove */ }
  try { environment.app = (await import('../shell/daemon.ts')).desktopVersion() } catch { /* the report says nothing about the app */ }
  try {
    const { getClient } = await import('../state.ts')
    const version = getClient()?.info?.version
    if (version) environment.daemon = version
  } catch { /* not connected */ }
  try {
    const hub = (await import('../machines/index.ts')).machineHub()
    for (const connection of hub.connections()) names.machines.push(connection.record.name)
  } catch { /* no machines to name */ }
  return { environment, names }
}

/** The redacted draft for `view`. */
export function draftFor(view: ProblemView, context: ReportContext): ProblemReport {
  return buildProblemReport(view, context.environment, context.names)
}

/** Opens the review sheet with the draft for `view`. */
export async function reportProblem(view: ProblemView): Promise<void> {
  const draft = draftFor(view, await reportContext())
  const { showDialog } = await import('../dialogs/store.ts')
  showDialog({ kind: 'report', draft })
}
