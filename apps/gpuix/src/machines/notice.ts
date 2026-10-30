// "Name your machines" in Settings → Machines is a one-time hint; dismissing it is remembered in a small file in the client
// config dir, so a scratch config never touches the real one. (The network's own intro is `intro.ts`.)
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { writeAllowed } from '../shell/persist.ts'

export const NAMES_HINT_FILE = 'machine-names-hint.json'
export function namesHintDismissed(dir: string): boolean {
  try { return (JSON.parse(readFileSync(path.join(dir, NAMES_HINT_FILE), 'utf8')) as { dismissed?: boolean }).dismissed === true } catch { return false }
}
export function dismissNamesHint(dir: string) {
  const file = path.join(dir, NAMES_HINT_FILE)
  if (!writeAllowed(file)) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ dismissed: true, at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(temp, file)
  } catch { /* the hint comes back next time */ }
}
