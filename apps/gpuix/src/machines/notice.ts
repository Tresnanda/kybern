// The one-time notice (design §5.2): after an upgrade the network is on by default, so a machine of the user's that
// shares their Tailscale account can join without a click. The first time this device sees a daemon with the network on
// it says so once, and says where to look. The flag is a small file in the client config dir, so a scratch config
// never touches the real one.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { NetworkStatus } from '../../../../packages/kybern-client/src/types.ts'
import { writeAllowed } from '../shell/persist.ts'

export const NOTICE_FILE = 'network-notice.json'

export interface NoticeText { title: string; description: string }

/** What to say, or `null` when there is nothing to tell: the network is off, or this device was told already. */
export function noticeFor(status: Pick<NetworkStatus, 'enabled' | 'members' | 'tailscale'>, alreadyShown: boolean): NoticeText | null {
  if (alreadyShown || !status.enabled) return null
  const others = status.members.filter((member) => !member.is_self).length
  const description = status.tailscale.running
    ? 'Machines signed in to your Tailscale account can now find each other. You will see all their projects together. Change this in Settings → Machines.'
    : 'Kybern can find your other machines through Tailscale, which is not running here. Change this in Settings → Machines.'
  return { title: others > 0 ? `Your machines are connected (${others + 1})` : 'Your machines can now find each other', description }
}

export function noticeShown(dir: string): boolean {
  try { return (JSON.parse(readFileSync(path.join(dir, NOTICE_FILE), 'utf8')) as { shown?: boolean }).shown === true } catch { return false }
}

export function markNoticeShown(dir: string) {
  const file = path.join(dir, NOTICE_FILE)
  if (!writeAllowed(file)) return
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ shown: true, at: new Date().toISOString() }), { mode: 0o600 })
    renameSync(temp, file)
  } catch { /* a read-only config folder only means it is said again next time */ }
}
