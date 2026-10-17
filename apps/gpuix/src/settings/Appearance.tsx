// Settings › Appearance (desktop `SettingsScreen.tsx` `Appearance`): the three
// theme cards and the window material switch. Both apply live: the theme
// re-themes the app and the window, and "Use translucent surfaces" turns the
// content surfaces into glass over the native material (`platform/material.ts`).
import { useState } from 'react'
import { Label, useTheme } from '../ui.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { PageBlock, Row, Section, Switch } from './controls.tsx'
import { setAppearance, useAppearance } from './appearance.ts'

export function Appearance() {
  const t = useTheme()
  const prefs = useAppearance()
  const [error, setError] = useState('')
  const save = (patch: Parameters<typeof setAppearance>[0]) => { try { setAppearance(patch); setError('') } catch (e) { setError(`Unable to save appearance. ${String(e)}`) } }
  return <>
    <PageBlock><div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 30 }}><Label color={t.text} size={14} lineHeight={19.6} weight={600}>Theme</Label>
      <div style={{ display: 'flex', gap: 14 }}>{(['light', 'dark', 'system'] as const).map((value) => {
        const preview = { frame: value === 'dark' ? '#202023' : '#f7f7f8', text: value === 'system' ? '#929299' : value === 'dark' ? '#ededf0' : '#27272a' }
        return <div key={value} testId={`settings-theme-${value}`} tabIndex={0} aria-label={`${value} theme`} aria-pressed={prefs.theme === value} onClick={() => save({ theme: value })} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') save({ theme: value }) }} style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0, cursor: 'pointer' }}>
          <div style={{ display: 'flex', pointerEvents: 'none', height: 112, borderWidth: 1, borderColor: prefs.theme === value ? 'transparent' : t.border, ...(prefs.theme === value ? { boxShadow: { offsetX: 0, offsetY: 0, blurRadius: 0, spreadRadius: 2, color: t.text } } : {}), borderRadius: 10, padding: 10, ...(value === 'system' ? { background: { type: 'linear-gradient' as const, angle: 110, stops: [{ color: '#f7f7f8', position: 0.499 }, { color: '#202023', position: 0.501 }] } } : { backgroundColor: preview.frame }) }}>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', width: '28%', paddingTop: 14, paddingRight: 7, gap: 9, borderRightWidth: 1, borderColor: preview.text, opacity: 0.25 }}>{[0, 1, 2].map((i) => <div key={i} style={{ pointerEvents: 'none', height: 4, borderRadius: 3, backgroundColor: preview.text }} />)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', pointerEvents: 'none', flexGrow: 1, paddingTop: 16, paddingLeft: 12 }}>
              <div style={{ width: '48%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.6, marginBottom: 7 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25, marginBottom: 7 }} />
              <div style={{ height: 24, borderWidth: 1, borderColor: preview.text, borderRadius: 4, opacity: 0.15, marginTop: 5, marginBottom: 12 }} />
              <div style={{ width: '76%', height: 4, borderRadius: 2, backgroundColor: preview.text, opacity: 0.25 }} />
            </div>
          </div><div style={{ display: 'flex', pointerEvents: 'none', gap: 7, paddingTop: 13, alignItems: 'center' }}><Icon source={value === 'system' ? N.laptop : value === 'dark' ? N.moon : N.sun} size={16} color={t.text} /><Label color={t.text} size={13}>{value[0].toUpperCase() + value.slice(1)}</Label></div>
        </div>
      })}</div>
      <Label color={t.textSecondary} size={12} lineHeight={19.2}>System follows your device’s light and dark appearance.</Label>
    </div></PageBlock>
    <Section title="Window material"><Row title="Use translucent surfaces" description="Let your desktop show softly through the sidebar and floating controls. Follows your system’s reduced transparency preference."><Switch label="Use translucent surfaces" testId="settings-translucency" checked={prefs.translucent} onChange={(translucent) => save({ translucent })} /></Row></Section>
    {error && <Label color={t.red}>{error}</Label>}
  </>
}
