import { AccountsHeaderAction } from './Accounts.tsx'
import { onEnvironmentChange, useEnvironment } from '../shell/environment.ts'
import { motion, useGpuix } from '@gpuix/react'
import { useEffect, useState } from 'react'
import { setSettingsTitle } from './Breadcrumb.tsx'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { S } from './glyphs.ts'
import { getNav, setNav } from '../nav/store.ts'
import { EASE_OUT, ink, Label, REDUCED_MOTION, useTheme } from '../ui.tsx'
import { settingsOverlayOwnsEscape, TextField } from './controls.tsx'
import { useSettings, useSettingsConnection } from './store.ts'
import { General, Appearance, Agents, About } from './primary.tsx'
import { Accounts, Integrations, Computer, Background, Notifications } from './secondary.tsx'

export const TABS = [
  ['general', 'General', 'Defaults for new threads and workspace behavior.', N.settings, 'default agent permissions worktree titles close notes preview'],
  ['appearance', 'Appearance', 'Make Kybern feel at home on your desktop.', N.sun, 'theme light dark system translucent glass window'],
  ['notifications', 'Notifications', 'Choose when Kybern gets your attention.', N.bell, 'alerts sound permission finishes fails input'],
  ['agents', 'Agent providers', 'Manage the coding agents on your connected machine.', S.terminal, 'harness install updates claude codex cursor opencode pi omp profiles sdk delegation coordinator autonomy models'],
  ['accounts', 'Accounts', 'Sign in to more than one account for each agent. Threads use the default unless you pick another account in the model picker.', N.users, 'login email plan default project color work personal'],
  ['integrations', 'Integrations', 'Plugins and connectors for your agents.', S.plugin, 'tools mcp skills authentication'],
  ['computer', 'Computer use', 'Let agents read and use apps on this Mac.', N.laptop, 'cuadriver screen accessibility recording cursor'],
  ['background', 'Background activity', 'Manage idle agents, terminals, and power use.', S.backgroundTray, 'memory warm shells daemon battery'],
  ['about', 'About', 'App version, updates, and connected machine.', N.info, 'protocol host data folder cli path'],
] as const
export type Tab = typeof TABS[number][0]
let lastTab: Tab = 'general'
const tabListeners = new Set<() => void>()
export function openSettingsTab(tab: Tab) {
 lastTab = tab; setSettingsTitle(TABS.find(item => item[0] === tab)![1]);
 for (const listener of tabListeners) listener()
 if (!getNav().settingsOpen) setNav({ settingsOpen: true })
}
const GROUPS = [{ label: 'Personal', ids: ['general', 'appearance', 'notifications'] }, { label: 'Coding', ids: ['agents', 'accounts', 'integrations', 'computer'] }, { label: 'System', ids: ['background', 'about'] }]

export function SettingsScreen() {
  const environment = useEnvironment()
  const t = useTheme()
  const { renderer } = useGpuix()
  const [previousFocus] = useState(() => renderer?.getFocusedElementId?.())
  const [tab, setTab] = useState<Tab>(lastTab)
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  // Keep pointer navigation batched with its local keyboard/search state.
  // External rail/menu entries notify this mounted screen, or seed lastTab.
  useEffect(() => {
    const changed = () => { setTab(lastTab); setQuery('') }
    tabListeners.add(changed)
    return () => { tabListeners.delete(changed) }
  }, [])
  const [keyboard, setKeyboard] = useState(false)
  const { settings, error } = useSettings()
  useSettingsConnection()
  useEffect(() => {
    return () => { if (previousFocus != null) queueMicrotask(() => renderer?.focusElement?.(previousFocus)) }
  }, [renderer, previousFocus])
  const select = (next: Tab, key = false) => { openSettingsTab(next); setKeyboard(key); setQuery('') }
  const close = (fromKeyboard = false) => setNav({ settingsOpen: false, keyboardNav: fromKeyboard, panelInstant: fromKeyboard })
  const current = TABS.find((item) => item[0] === tab)!
  const matches = TABS.filter((item) => `${item[1]} ${item[2]} ${item[4]}`.toLowerCase().includes(query.trim().toLowerCase()))
  const rows: ({ group: string } | { item: typeof TABS[number] })[] = []
  for (const group of GROUPS) {
    const items = matches.filter((item) => group.ids.includes(item[0]))
    if (items.length) { rows.push({ group: group.label }); rows.push(...items.map((item) => ({ item }))) }
  }
  let offset = 0
  let pillTop = -1
  for (const row of rows) {
    if ('group' in row) offset += (offset ? 14 : 0) + 33
    else { if (row.item[0] === tab) pillTop = offset; offset += 30 }
  }
  const content = tab === 'general' ? <General /> : tab === 'appearance' ? <Appearance /> : tab === 'agents' ? <Agents /> : tab === 'about' ? <About /> : tab === 'notifications' ? <Notifications /> : tab === 'background' ? <Background /> : tab === 'accounts' ? <Accounts /> : tab === 'integrations' ? <Integrations /> : <Computer />
  return <div testId="page-settings" onKeyDown={(e) => { if (e.key === 'tab' && !settingsOverlayOwnsEscape()) { if (e.modifiers?.shift) renderer?.focusPrevious?.(); else renderer?.focusNext?.() } if (e.key === 'escape' && !settingsOverlayOwnsEscape()) { if (query) setQuery(''); else close(true) } }} style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
    <div style={{ display: 'flex', flexDirection: 'column', width: 256, flexShrink: 0, paddingLeft: 6, paddingRight: 6, paddingTop: 8, paddingBottom: 12, backgroundColor: t.sidebar, borderTopLeftRadius: 12, borderBottomLeftRadius: 12 }}>
      <div testId="settings-back" tabIndex={0} autoFocus onClick={() => close()} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') close(true) }} style={{ display: 'flex', alignItems: 'center', height: 28, gap: 8, paddingLeft: 8, borderRadius: 8, hover: { backgroundColor: t.hover } }}><Icon source={N.arrowLeft} size={16} color={t.iconSecondary} /><Label color={t.text} size={14} lineHeight={21}>Back to workspace</Label></div>
      <div style={{ display: 'flex', position: 'relative', paddingTop: 8, paddingBottom: 8 }}><div style={{ position: 'absolute', left: 12, top: 16, pointerEvents: 'none' }}><Icon source={N.search} size={14} color={t.textSecondary} /></div><TextField testId="settings-search" tabIndex={0} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} label="Search settings" placeholder="Search settings…" style={{ position: 'relative', left: -0.5, top: -0.5, height: 31, borderRadius: 10, paddingLeft: 38, fontSize: 14, backgroundColor: t.inputGroupFill, borderColor: searchFocused ? ink(t, .3) : t.v('--input') }} value={query} onChange={setQuery} width="100%" onSubmit={() => { if (matches[0]) select(matches[0][0], true) }} onKeyDown={(e) => { if (e.key === 'escape' && !settingsOverlayOwnsEscape()) { if (query) setQuery(''); else close(true) } }} /></div>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {!query && pillTop >= 0 && <motion.div initial={false} animate={{ top: pillTop }} transition={{ duration: keyboard || REDUCED_MOTION ? 0 : 0.22, ease: EASE_OUT }} style={{ position: 'absolute', left: 0, right: 0, height: 28, borderRadius: 6, backgroundColor: t.v('--sidebar-accent-active') }} />}
        {rows.map((row) => 'group' in row ? <div key={row.group} style={{ display: 'flex', alignItems: 'center', height: 33, marginTop: rows.indexOf(row) === 0 ? 0 : 14, paddingLeft: 8 }}><Label color={t.textSecondary} size={14} lineHeight={21} weight={500}>{row.group}</Label></div> : <div key={row.item[0]} testId={`settings-tab-${row.item[0]}`} tabIndex={0} aria-label={row.item[1]} onClick={() => select(row.item[0])} onKeyDown={(e) => { if (e.key === 'enter' || e.key === 'space') select(row.item[0], true) }} style={{ display: 'flex', position: 'relative', alignItems: 'center', height: 28, marginBottom: 2, paddingLeft: 8, gap: 8, borderRadius: 6, hover: { backgroundColor: row.item[0] === tab ? 'transparent' : t.hover } }}><Icon source={row.item[3]} size={16} color={t.text} /><Label color={t.text} size={14} lineHeight={21}>{row.item[1]}</Label></div>)}
        {!matches.length && <div style={{ padding: 8 }}><Label color={t.textSecondary} size={14} lineHeight={21}>{`No settings match “${query}”.`}</Label><div testId="settings-clear-search" tabIndex={0} onClick={() => setQuery('')} onKeyDown={e => { if (e.key === 'enter' || e.key === 'space') setQuery('') }} style={{ padding: 8, borderRadius: 8, hover: { backgroundColor: t.hover } }}><Label color={t.text} size={14}>Clear search</Label></div></div>}
      </div>
      <div style={{ flexGrow: 1 }} /><div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 8 }}><div style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, backgroundColor: ink(t, 0.58 * 0.5) }} /><Label color={t.textSecondary} size={14} lineHeight={21}>{environment.name}</Label></div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
      {error && <div style={{ padding: 16 }}><Label color={t.red} size={13}>{error}</Label></div>}
      <virtual-list key={tab} testId="settings-content" style={{ flexGrow: 1, minHeight: 0 }}>
        <div key="heading" style={{ display: 'flex', justifyContent: 'center', width: '100%', paddingTop: 26, paddingBottom: 34, paddingLeft: 40, paddingRight: 40 }}><div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 680, gap: 9, position: 'relative' }}><div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16}}><Label color={t.text} size={28} lineHeight={33.6} weight={600}>{current[1]}</Label>{tab === 'accounts' && <AccountsHeaderAction/>}</div><Label color={t.textSecondary} size={14} lineHeight={22.4} style={{maxWidth:tab === 'accounts' ? 520 : undefined}}>{current[2]}</Label></div></div>
        {!settings && <div key="loading" style={{ padding: 40 }}><Label color={t.textSecondary}>Reading settings…</Label></div>}
        {settings && content}
        <div key="bottom" style={{ height: 64 }} />
      </virtual-list>
    </div>
  </div>
}

onEnvironmentChange(() => { lastTab = 'general'; for (const listener of tabListeners) listener() })
