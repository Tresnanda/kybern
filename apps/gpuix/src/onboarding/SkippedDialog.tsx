// "View skipped" (v1 SPEC §6): a dialog titled "3 chats were skipped" that lists each skipped chat with the daemon's own sentence
// and the project it belongs to, under a Done button. Opened from the import toast and from the Projects scene; reads the
// import summary, which outlives the flow.
import { useWindowSize } from '@gpuix/react'
import { Button } from '../kit/Button.tsx'
import { Dialog, DialogHeader } from '../nav/overlay.tsx'
import { Label, useTheme } from '../ui.tsx'
import { createStore } from './store.ts'
import { groupSkipped, skippedTitle, unlistedSkips, type SkippedChat } from './skipped.ts'
import { useImportSummary } from './projectsStore.ts'

const open = createStore({ shown: false })
export const viewSkipped = () => open.set({ shown: true })
/** The dialog is up: the scene under it does not take ⌘↵. */
export const skippedOpen = () => open.get().shown
const close = () => open.set({ shown: false })

/** Mounted once in the app (by `HandoffController`), above the flow's layer. */
export function SkippedDialog() {
  const shown = open.use((s) => s.shown)
  return shown ? <Skipped /> : null
}

function Skipped() {
  const t = useTheme()
  const size = useWindowSize({ intervalMs: 250 })
  const summary = useImportSummary()
  const chats: SkippedChat[] = summary.skippedDetails
  const groups = groupSkipped(chats)
  const more = unlistedSkips(summary.skipped, chats.length)
  return (
    <Dialog onClose={close} width={512} testId="skipped-dialog">
      <DialogHeader title={skippedTitle(Math.max(summary.skipped, chats.length))} description="Kybern left these out of the import. Everything else is in your sidebar." onClose={close} />
      <div role="list" aria-label="Skipped chats" style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: 12, maxHeight: Math.max(160, size.height - 260), minHeight: 0, flexShrink: 1, overflowY: 'scroll' }}>
        {groups.map((group) => (
          <div key={group.project} role="group" aria-label={group.project} testId="skipped-group" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Label color={t.textSecondary} size={12} lineHeight={16} weight={600} truncate>{group.project}</Label>
            {group.chats.map((chat, i) => (
              <div key={`${chat.title}:${i}`} role="listitem" testId="skipped-chat" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Label color={t.text} size={14} lineHeight={20} weight={500} truncate>{chat.title}</Label>
                <Label color={t.textSecondary} size={13} lineHeight={19}>{chat.detail}</Label>
              </div>
            ))}
          </div>
        ))}
        {more > 0 && <Label color={t.textTertiary} size={13} lineHeight={19}>{`${new Intl.NumberFormat('en').format(more)} more aren’t listed here.`}</Label>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingLeft: 16, paddingRight: 16, paddingTop: 4, paddingBottom: 16 }}>
        <Button testId="skipped-done" variant="primary" size="lg" onClick={close}>Done</Button>
      </div>
    </Dialog>
  )
}
