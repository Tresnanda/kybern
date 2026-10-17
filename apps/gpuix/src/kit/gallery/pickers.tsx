// GPUIX twin of `visual/kit/sections/pickers.tsx`: selects in the left column at x = 40, comboboxes in the right
// column at x = 600, the same options and sizes as the desktop section.
import type { ComponentType } from 'react'
import { Combobox } from '../Combobox.tsx'
import { Select, type SelectEntry } from '../Select.tsx'

const THEMES: SelectEntry[] = [
  { group: 'Appearance' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
  { separator: true },
  { value: 'custom', label: 'Custom…', disabled: true },
]
const DENSITY = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
]
const BRANCHES = ['main', 'feat/gpuix-mvp', 'feat/orchestrator-v2', 'fix/claude-usage-stale', 'fix/ssh-tunnel-controlmaster', 'release/v0.9.1']
const LABELS = ['bug', 'design', 'performance', 'mobile', 'desktop']

function SmallSelect({ id, size, variant, disabled, placeholder }: { id: string; size?: 'xs' | 'sm' | 'default' | 'lg'; variant?: 'ghost'; disabled?: boolean; placeholder?: boolean }) {
  return <Select options={DENSITY} defaultValue={placeholder ? null : 'comfortable'} placeholder="Density" size={size} variant={variant} disabled={disabled} width={variant ? undefined : 160} testId={id} />
}

function PickersDemo() {
  return (
    <>
      <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
        <Select options={THEMES} defaultValue="dark" width={200} testId="select" />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SmallSelect id="select-lg" size="lg" />
          <SmallSelect id="select-sm" size="sm" />
          <SmallSelect id="select-xs" size="xs" />
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SmallSelect id="select-ghost" variant="ghost" />
          <SmallSelect id="select-placeholder" placeholder />
          <SmallSelect id="select-disabled" disabled />
        </div>
        <Select options={DENSITY} defaultValue="comfortable" width={200} surface="composer" testId="select-below" />
      </div>
      <div style={{ position: 'absolute', left: 600, top: 40, display: 'flex', flexDirection: 'column', gap: 16, width: 280 }}>
        <Combobox items={BRANCHES} placeholder="Search branches" emptyText="No branches found." testId="combobox" />
        <Combobox items={BRANCHES} defaultValue="main" placeholder="Base branch" showTrigger={false} showClear emptyText="No branches found." testId="combobox-clear" />
        <Combobox items={LABELS} multiple defaultValue={['bug', 'design']} placeholder="Add label" emptyText="No labels found." testId="combobox" />
      </div>
    </>
  )
}

export const sections: Record<string, ComponentType> = { pickers: PickersDemo }
