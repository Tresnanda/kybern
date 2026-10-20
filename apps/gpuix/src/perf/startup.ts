/** Opt-in startup timeline; dormant in normal sessions. Uses wall time so a
 * parent harness can relate module evaluation to process spawning. */
export function startupMark(phase: string, detail?: Record<string, unknown>) {
  if (process.env.KYBERN_STARTUP_TRACE === '1') console.error('[kybern-startup]', JSON.stringify({ phase, at: Date.now(), ...detail }))
}
startupMark('first-module')
