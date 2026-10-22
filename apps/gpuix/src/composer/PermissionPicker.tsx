// The permission-mode chip and its menu (`views/Composer.tsx:1248-1297`, the
// `.runtime-mode-menu` rules in `kit.css:3121`): 26rem wide, 6px body padding,
// 44px two-line rows 4px apart, an 18px icon 12px from the text, and the check
// on the selected mode. "Approve for me" reads in the accent when chosen; Full
// access is orange throughout, and so is its trigger.
import { Icon } from '../icons.tsx'
import { Label, useTheme } from '../ui.tsx'
import type { PermissionMode, ProviderStatus } from '../../../../packages/kybern-client/src/types.ts'
import { G } from './glyphs.ts'
import { CheckMark, PickerItem, PickerMenu } from './Menu.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { useFooterFit } from './footerWidth.tsx'
import { usePaneCompact } from '../state.ts'

interface ModeInfo {
  mode: PermissionMode
  label: string
  description: string
  icon: string
}

export const MODES: ModeInfo[] = [
  { mode: 'supervised', label: 'Ask for approval', description: 'Always ask before editing files or running commands', icon: G.hand },
  { mode: 'accept-edits', label: 'Approve edits', description: 'Edit files freely, ask before running commands', icon: G.pencil },
  { mode: 'auto', label: 'Approve for me', description: 'Only ask for actions detected as potentially unsafe', icon: G.shieldCheck },
  { mode: 'full-access', label: 'Full access', description: 'Unrestricted access to the internet and any file on your computer', icon: G.shield },
]

/** The modes an agent offers, with Cursor's SDK wording (`Composer.tsx:899-906`). */
export function modesFor(kind: string | undefined, legacyCursor: boolean): ModeInfo[] {
  if (kind !== 'cursor' || legacyCursor) return MODES
  return MODES.filter((m) => m.mode === 'auto' || m.mode === 'full-access').map((m) =>
    m.mode === 'auto'
      ? { ...m, label: 'Auto-review', description: 'Run in Cursor’s sandbox with automatic review; no approval prompts' }
      : { ...m, description: 'Disable Cursor’s sandbox and automatic review' },
  )
}

export function PermissionPicker({
  mode,
  kind,
  status,
  legacyCursor = false,
  locked,
  onChange,
}: {
  mode: PermissionMode
  kind: string | undefined
  status: ProviderStatus | undefined
  legacyCursor?: boolean
  locked?: boolean
  onChange: (mode: PermissionMode) => void
}) {
  const t = useTheme()
  const modes = modesFor(kind, legacyCursor)
  const supported = (m: PermissionMode) => legacyCursor || !status || status.supported_permission_modes.includes(m)
  const current = modes.find((m) => m.mode === mode && supported(m.mode))
  const effective = MODES.find((m) => m.mode === mode)!
  const info = current ?? { ...effective, label: 'Choose permissions', description: `${effective.label} is not supported by the selected agent` }
  const accent = mode === 'full-access' ? t.fullAccess : mode === 'auto' ? t.link : undefined
  // `@max-[480px]:sr-only` (and always in a split pane): the label leaves, the icon chip stays.
  const showLabel = useFooterFit().labels && !usePaneCompact()

  return (
    <PickerMenu
      testId="mode-picker"
      side="top"
      align="start"
      width={416}
      padding={6}
      gap={4}
      disabled={locked}
      trigger={(open) => (
        <PickerChip
          truncate
          open={open}
          chevron={showLabel}
          label={info.label}
          lead={<Icon source={info.icon} size={16} color={accent ?? t.iconSecondary} />}
        >
          {showLabel ? <Label color={accent ?? t.text} size={13} lineHeight={18} weight={500} truncate>{info.label}</Label> : null}
        </PickerChip>
      )}
    >
      {modes.map((m) => {
        const checked = m.mode === mode
        const tone = m.mode === 'full-access' ? t.fullAccess : m.mode === 'auto' && checked ? t.link : null
        return (
          <PickerItem
            key={m.mode}
            id={m.mode}
            testId={`mode-${m.mode}`}
            disabled={!supported(m.mode)}
            onSelect={() => {
              if (!checked) onChange(m.mode)
            }}
            style={{ minHeight: 44, paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexGrow: 1, minWidth: 0 }}>
              <Icon source={m.icon} size={18} color={tone ?? t.text} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flexShrink: 1 }}>
                <Label color={tone ?? t.text} weight={500} lineHeight={17.5}>
                  {m.label}
                </Label>
                <Label color={tone ?? t.textSecondary} size={12} lineHeight={16.5}>
                  {m.description}
                </Label>
              </div>
            </div>
            <CheckMark color={tone ?? t.text} visible={checked} />
          </PickerItem>
        )
      })}
    </PickerMenu>
  )
}
