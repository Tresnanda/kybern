// Settings → Agent providers → Compaction (issue #295): "Compact idle threads" with a count of the accounts that
// choose for themselves (their ⋯ menu, `AccountIdleCompaction`), and "Auto-compact at", one compact select per agent
// that has its own limit, like "Default models". Words are shared (`packages/kybern-client/src/compaction.ts`).
import {
  AUTO_COMPACT_CHOICES,
  AUTO_COMPACT_HARNESSES,
  IDLE_COMPACTION_HARNESSES,
  IDLE_COMPACTION_OPTIONS,
  autoCompactLabel,
  idleCompactionLabel,
} from '../../../../packages/kybern-client/src/compaction.ts'
import type { CompactionSettings, IdleCompaction, ProviderKind, Settings } from '../../../../packages/kybern-client/src/types.ts'
import { MenuItem, MenuSeparator, MenuSub } from '../nav/overlay.tsx'
import { useNav } from '../nav/store.ts'
import { Row, Section, Select } from './controls.tsx'
import { latestSettings, updateSettings, useSettings } from './store.ts'

const DEFAULT_COMPACTION: CompactionSettings = { idle: 'when_you_return' }

function compaction(settings: Settings | null | undefined): CompactionSettings {
  return settings?.compaction ?? DEFAULT_COMPACTION
}

/** How many accounts choose their own "Compact idle threads". */
export function accountOverrides(settings: Settings | null | undefined): number {
  return Object.values(settings?.providers ?? {}).reduce((count, provider) => count + Object.keys(provider?.idle_compaction ?? {}).length, 0)
}

export function overridesStatus(count: number): string | undefined {
  if (count === 0) return undefined
  return count === 1 ? '1 account uses its own setting.' : `${count} accounts use their own setting.`
}

/** One account's own choice, or `null` to follow the global one. */
export function setAccountIdleCompaction(kind: ProviderKind, instance: string, mode: IdleCompaction | null) {
  const settings = latestSettings()
  if (!settings) return
  const provider = settings.providers[kind] ?? { env: {} }
  const idle_compaction = { ...provider.idle_compaction }
  if (mode) idle_compaction[instance] = mode
  else delete idle_compaction[instance]
  void updateSettings({ providers: { ...settings.providers, [kind]: { ...provider, idle_compaction } } })
}

export function CompactionSection() {
  const { settings: s, saving } = useSettings()
  const providers = useNav((state) => state.providers)
  if (!s) return null
  const current = compaction(s)
  const option = IDLE_COMPACTION_OPTIONS.find((item) => item.value === current.idle) ?? IDLE_COMPACTION_OPTIONS[0]!
  const change = (patch: Partial<CompactionSettings>) => void updateSettings({ compaction: { ...compaction(latestSettings()), ...patch } })
  const setThreshold = (kind: ProviderKind, tokens: number | null) => {
    const thresholds = { ...compaction(latestSettings()).auto_compact_tokens }
    if (tokens) thresholds[kind] = tokens
    else delete thresholds[kind]
    change({ auto_compact_tokens: thresholds })
  }
  const agents = providers.filter((provider) => provider.available && AUTO_COMPACT_HARNESSES.includes(provider.kind))
  return (
    <Section title="Compaction">
      <Row title="Compact idle threads" description={option.description} status={overridesStatus(accountOverrides(s))} shared="compaction">
        <Select label="Compact idle threads" testId="settings-idle-compaction" value={current.idle} disabled={saving} options={IDLE_COMPACTION_OPTIONS.map(({ value, label }) => ({ value, label }))} onChange={(value) => change({ idle: value as IdleCompaction })} />
      </Row>
      {agents.length > 0 && <Row title="Auto-compact at" description="Agents summarize a thread when its context passes this size. Default keeps each agent’s own limit." />}
      {agents.map((provider) => {
        const tokens = current.auto_compact_tokens?.[provider.kind] ?? null
        return (
          <Row key={provider.kind} title={provider.display_name} mark={provider.kind}>
            <Select
              label={`${provider.display_name} auto-compact threshold`}
              testId={`settings-auto-compact-${provider.kind}`}
              compact
              value={tokens ? String(tokens) : ''}
              disabled={saving}
              options={AUTO_COMPACT_CHOICES.map((choice) => ({ value: choice ? String(choice) : '', label: autoCompactLabel(choice) }))}
              onChange={(value) => setThreshold(provider.kind, value ? Number(value) : null)}
            />
          </Row>
        )
      })}
    </Section>
  )
}

/** The account ⋯ menu's "Compact idle threads": follow the global choice, or the account's own. */
export function AccountIdleCompaction({ kind, instance, testId }: { kind: ProviderKind; instance: string; testId: string }) {
  const { settings } = useSettings()
  if (!IDLE_COMPACTION_HARNESSES.includes(kind)) return null
  const own = settings?.providers[kind]?.idle_compaction?.[instance] ?? null
  const global = compaction(settings).idle
  return (
    <MenuSub id="idle-compaction" testId={testId} label="Compact idle threads" width={280}>
      <MenuItem id="idle-compaction-default" testId={`${testId}-default`} label={`Use default (${idleCompactionLabel(global)})`} checked={own === null} onSelect={() => setAccountIdleCompaction(kind, instance, null)} />
      <MenuSeparator />
      {IDLE_COMPACTION_OPTIONS.map(({ value, label }) => (
        <MenuItem key={value} id={`idle-compaction-${value}`} testId={`${testId}-${value}`} label={label} checked={own === value} onSelect={() => setAccountIdleCompaction(kind, instance, value)} />
      ))}
    </MenuSub>
  )
}
