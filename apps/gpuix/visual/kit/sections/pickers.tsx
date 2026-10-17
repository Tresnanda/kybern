// Desktop picker gallery: the real `components/kit/select` and `components/kit/combobox`. Left column at x = 40:
// selects (settings surface aligned to the selected item, sizes, ghost, placeholder, disabled, and the composer
// surface below its trigger); right column at x = 600: comboboxes (trigger, clear, chips for multiple).
import type { ComponentType } from 'react'
import { ComposerPickerSelectPopup } from '@/components/kit/chat/ComposerPickerMenuPopup'
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList,
  ComboboxPopup, ComboboxValue,
} from '@/components/kit/combobox'
import {
  Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectSeparator, SelectTrigger, SelectValue,
} from '@/components/kit/select'

export const THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]
export const DENSITY = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
]
export const BRANCHES = ['main', 'feat/gpuix-mvp', 'feat/orchestrator-v2', 'fix/claude-usage-stale', 'fix/ssh-tunnel-controlmaster', 'release/v0.9.1']
export const LABELS = ['bug', 'design', 'performance', 'mobile', 'desktop']

function SmallSelect({ id, size, variant, disabled, placeholder }: { id: string; size?: 'xs' | 'sm' | 'default' | 'lg'; variant?: 'ghost'; disabled?: boolean; placeholder?: boolean }) {
  return (
    <Select items={DENSITY} defaultValue={placeholder ? null : 'comfortable'} disabled={disabled}>
      <SelectTrigger size={size} variant={variant} className={variant ? undefined : 'w-[160px]'} data-testid={`${id}-trigger`}><SelectValue placeholder="Density" /></SelectTrigger>
      <SelectPopup surface="settings">
        {DENSITY.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}
      </SelectPopup>
    </Select>
  )
}

function PickersDemo() {
  return (
    <>
      <div style={{ position: 'absolute', left: 40, top: 40, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
        <Select items={THEMES} defaultValue="dark">
          <SelectTrigger className="w-[200px]" data-testid="select-trigger"><SelectValue /></SelectTrigger>
          <SelectPopup surface="settings" data-testid="select-popup">
            <SelectGroup>
              <SelectGroupLabel>Appearance</SelectGroupLabel>
              {THEMES.map((th) => <SelectItem key={th.value} value={th.value} data-testid={`select-option-${th.value}`}>{th.label}</SelectItem>)}
            </SelectGroup>
            <SelectSeparator />
            <SelectItem value="custom" disabled data-testid="select-option-custom">Custom…</SelectItem>
          </SelectPopup>
        </Select>
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
        <Select items={DENSITY} defaultValue="comfortable">
          <SelectTrigger className="w-[200px]" data-testid="select-below-trigger"><SelectValue /></SelectTrigger>
          <ComposerPickerSelectPopup data-testid="select-below-popup">
            {DENSITY.map((d) => <SelectItem key={d.value} value={d.value} data-testid={`select-below-option-${d.value}`}>{d.label}</SelectItem>)}
          </ComposerPickerSelectPopup>
        </Select>
      </div>
      <div style={{ position: 'absolute', left: 600, top: 40, display: 'flex', flexDirection: 'column', gap: 16, width: 280 }}>
        <Combobox items={BRANCHES}>
          <ComboboxInput placeholder="Search branches" data-testid="combobox-input" />
          <ComboboxPopup data-testid="combobox-popup">
            <ComboboxEmpty>No branches found.</ComboboxEmpty>
            <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item} data-testid={`combobox-option-${item}`}>{item}</ComboboxItem>}</ComboboxList>
          </ComboboxPopup>
        </Combobox>
        <Combobox items={BRANCHES} defaultValue="main">
          <ComboboxInput placeholder="Base branch" showTrigger={false} showClear data-testid="combobox-clear-input" />
          <ComboboxPopup>
            <ComboboxEmpty>No branches found.</ComboboxEmpty>
            <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item}>{item}</ComboboxItem>}</ComboboxList>
          </ComboboxPopup>
        </Combobox>
        <Combobox items={LABELS} multiple defaultValue={['bug', 'design']}>
          <ComboboxChips data-testid="combobox-chips">
            <ComboboxValue>
              {(value: string[]) => (
                <>
                  {value.map((v) => <ComboboxChip key={v} data-testid={`combobox-chip-${v}`}>{v}</ComboboxChip>)}
                  <ComboboxChipsInput placeholder={value.length ? '' : 'Add label'} data-testid="combobox-chips-input" />
                </>
              )}
            </ComboboxValue>
          </ComboboxChips>
          <ComboboxPopup>
            <ComboboxEmpty>No labels found.</ComboboxEmpty>
            <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item} data-testid={`combobox-option-${item}`}>{item}</ComboboxItem>}</ComboboxList>
          </ComboboxPopup>
        </Combobox>
      </div>
    </>
  )
}

export const sections: Record<string, ComponentType> = { pickers: PickersDemo }
