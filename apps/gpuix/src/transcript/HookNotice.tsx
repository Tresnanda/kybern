// "A hook couldn't check this action": the one row for every hook of a call that gave no answer (the projection folds them, `foldHookNotices`).
// It keeps the notice row's alert icon and muted text. One sentence of help appears when the cause is one we recognise; each hook, with the
// reason Claude Code gave, sits behind "Show details", as every error does. There is no fix button: Kybern doesn't edit people's settings.
import { hookWarningDetails, hookWarningHelp, type HookWarning } from '../../../../packages/kybern-client/src/hookWarnings.ts'
import { useDetails } from '../kit/Problem.tsx'
import { muted, Para, ROW_LINE, RowIcon } from './kit.tsx'
import { T } from './glyphs.ts'
import { useTreeSlot } from '../tree/Tree.tsx'
import { useTheme } from '../ui.tsx'

export function HookNotice({ title, hooks }: { title: string; hooks: readonly HookWarning[] }) {
  const t = useTheme()
  const tree = useTreeSlot()
  const help = hookWarningHelp(hooks)
  const details = useDetails(hookWarningDetails(hooks), 'hook-notice')
  return (
    <div testId="hook-notice" paintTransform={tree.rise} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 4, paddingBottom: 4, minWidth: 0 }}>
      <RowIcon box={20} size={16} source={T.alert} color={muted(t)} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, alignItems: 'flex-start' }}>
        <Para color={muted(t)} lineHeight={ROW_LINE} selectable>{title}</Para>
        {help && <Para color={muted(t)} lineHeight={ROW_LINE} selectable>{help}</Para>}
        <div style={{ marginLeft: -8 }}>{details.toggle}</div>
        {details.box && <div style={{ width: '100%', marginTop: 4 }}>{details.box}</div>}
      </div>
      {tree.lines}
    </div>
  )
}
