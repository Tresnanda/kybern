// The words for a failed install, uninstall or removal of the `kybern` terminal command (`platform/cli.ts`). A refused write (EPERM, EACCES,
// "operation not permitted") is the usual cause: the folder on PATH belongs to another user, or the disk is read-only. Anything else goes
// through `describeProblem`.

export type CliAction = 'install' | 'uninstall' | 'remove'

const VERB: Record<CliAction, string> = { install: 'install the kybern command', uninstall: 'uninstall the kybern command', remove: 'remove the older kybern command' }

export const cliActionPhrase = (action: CliAction) => VERB[action]

const REFUSED = /EPERM|EACCES|operation not permitted|permission denied|access is denied|read-only file system|EROFS/i

/** The headline and sentence when the write was refused, or `null` for another failure. */
export function cliRefusedCopy(action: CliAction, message: string): { title: string; body: string } | null {
  if (!REFUSED.test(message)) return null
  return {
    title: `Couldn't ${VERB[action]}`,
    body: action === 'install'
      ? 'Your account can’t write to the folder on your PATH. Make ~/.local/bin writable, then try again. Nothing else changed.'
      : 'Your account can’t change that file. Remove it from a terminal instead. Nothing else changed.',
  }
}
