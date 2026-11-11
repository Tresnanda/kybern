// OpenCode's Build / Plan choice, matching the terminal agent switch. It is not a
// Kybern permission mode: Plan is OpenCode's planning agent.
import { Label, useTheme } from '../ui.tsx'
import { CheckMark, PickerItem, PickerMenu } from './Menu.tsx'
import { PickerChip } from '../kit/PickerChip.tsx'
import { useFooterFit } from './footerWidth.tsx'
import { usePaneCompact } from '../state.ts'

export type OpenCodeAgent = 'build' | 'plan'

const AGENTS: { id: OpenCodeAgent; label: string; description: string }[] = [
  { id: 'build', label: 'Build', description: 'Implement changes in this conversation' },
  { id: 'plan', label: 'Plan', description: 'Explore and plan without editing project files' },
]

export function OpenCodeAgentPicker({
  agent,
  onChange,
}: {
  agent: OpenCodeAgent
  onChange: (agent: OpenCodeAgent) => void
}) {
  const t = useTheme()
  const current = AGENTS.find((item) => item.id === agent) ?? AGENTS[0]!
  const showLabel = useFooterFit().labels && !usePaneCompact()
  return (
    <PickerMenu
      testId="opencode-agent-picker"
      side="top"
      align="start"
      width={320}
      padding={6}
      gap={4}
      trigger={(open) => (
        <PickerChip bare truncate open={open} chevron={showLabel} label={current.label}>
          {showLabel ? <Label color={t.text} size={13} lineHeight={18} weight={500} truncate>{current.label}</Label> : null}
        </PickerChip>
      )}
    >
      {AGENTS.map((item) => {
        const checked = item.id === agent
        return (
          <PickerItem
            key={item.id}
            id={item.id}
            testId={`opencode-agent-${item.id}`}
            onSelect={() => {
              if (!checked) onChange(item.id)
            }}
            style={{ minHeight: 44, paddingLeft: 10, paddingRight: 10, paddingTop: 5, paddingBottom: 5 }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flexGrow: 1 }}>
              <Label color={t.text} weight={500} lineHeight={17.5}>{item.label}</Label>
              <Label color={t.textSecondary} size={12} lineHeight={16.5}>{item.description}</Label>
            </div>
            <CheckMark color={t.text} visible={checked} />
          </PickerItem>
        )
      })}
    </PickerMenu>
  )
}
