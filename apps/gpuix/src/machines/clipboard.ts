// The explicit machine clipboard in the app (U2): "Send clipboard to…" and "Paste from…". Both calls go to this machine's daemon,
// which relays to the other machine. Wording and limits are in `machineUtilities.ts`.
import { clipboardSentNotice, clipboardTooLarge, formatBytes, type SendTarget } from '../../../../packages/kybern-client/src/machineUtilities.ts'
import type { MachineId } from '../../../../packages/kybern-client/src/types.ts'
import { MAX_CLIPBOARD_BYTES } from '../../../../packages/kybern-client/src/types.ts'
import { errorText } from '../nav/actions.ts'
import { toast } from '../shell/toasts.tsx'
import { getClient } from '../state.ts'
import { readClipboardText } from '../transcript/store.ts'

/** Put this machine's clipboard text on `target`. Says the result in a toast. */
export async function sendClipboardTo(target: SendTarget): Promise<void> {
  const client = getClient()
  if (!client) return void toast.error('Unable to send the clipboard', { description: 'Not connected to kybernd. Reconnect, then try again.' })
  try {
    const text = await readClipboardText()
    if (!text) return void toast.info('Nothing to send', { description: 'The clipboard has no text. Copy some text first.' })
    if (clipboardTooLarge(text)) return void toast.error('The clipboard is too big to send', { description: `Text can be up to ${formatBytes(MAX_CLIPBOARD_BYTES)}. Copy less, or send a file instead.` })
    const notice = clipboardSentNotice(target.name, await client.call('clipboard.set', { machine: target.machineId, text }))
    toast.success(notice.title, { description: notice.description })
  } catch (error) {
    toast.error(`Unable to send the clipboard to ${target.name}`, { description: errorText(error) })
  }
}

/** The text on `source`'s clipboard, or null after a toast says why not. */
export async function readClipboardFrom(source: SendTarget): Promise<string | null> {
  const client = getClient()
  if (!client) { toast.error('Unable to paste', { description: 'Not connected to kybernd. Reconnect, then try again.' }); return null }
  try {
    const { text } = await client.call('clipboard.get', { machine: source.machineId })
    if (!text) { toast.info(`${source.name} has nothing to paste`, { description: 'Its clipboard has no text.' }); return null }
    return text
  } catch (error) {
    toast.error(`Unable to paste from ${source.name}`, { description: errorText(error) })
    return null
  }
}

/** Whether this machine shares the clipboard automatically (the daemon's own answer). */
export async function readClipboardAuto(): Promise<boolean> {
  const client = getClient()
  return client ? (await client.call('clipboard.status', {})).auto : false
}

/** Turn "Share clipboard automatically" on or off for this machine (capability `clipboard_auto`). */
export async function setClipboardAuto(machineId: MachineId, allowed: boolean): Promise<void> {
  const client = getClient()
  if (!client) throw new Error('Not connected to kybernd')
  await client.call('network.allow.set', { machine_id: machineId, capability: 'clipboard_auto', allowed })
}
