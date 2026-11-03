// The strip under the Browser's chrome while a forwarded page is still loading over a slow link (ADE-126). It sits in
// the chrome's column like the live-reload notice, so it never covers the page, and it goes away when the load ends.
import { Label, useTheme } from '../ui.tsx'
import { usePorts } from './ports.ts'
import { forwardOf, slowLoadText } from './slow.ts'
import { usePreview } from './store.ts'

export function SlowLoadStrip({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId), entry = s.entries[s.index], ports = usePorts(threadId)
  const text = entry?.machine ? slowLoadText(forwardOf(ports.forwards, entry.machine)?.loading) : null
  if (!text) return null
  return <div testId="preview-slow-load" role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, height: 28, flexShrink: 0 }}>
    <Label color={t.textSecondary} size={11} truncate>{text}</Label>
  </div>
}
