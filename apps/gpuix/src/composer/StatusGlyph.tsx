import { useEffect, useState } from 'react'
import { contextUsage, bindingLimit, limitLabel, limitLeftLabel } from '@/lib/providerUsage'
import { cacheState, cacheDotOpacity, glyphTone } from '@/lib/accountUi'
import { promptCacheWindow, promptCacheRemainingMinutes } from '@/lib/promptCache'
import type { ProviderInstance } from '../../../../packages/kybern-client/src/types.ts'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { useApp, usePaneAccess } from '../state.ts'
import { useNav } from '../nav/store.ts'
import { Icon } from '../icons.tsx'
import { Label, useTheme } from '../ui.tsx'
import { useComposer } from './store.ts'
import { PickerMenu } from './Menu.tsx'

/** The ring is context usage; the center dot is the provider's cache window. */
export function StatusGlyph({ provider, running }: { provider: ProviderInstance; running?: boolean }) {
  const t = useTheme()
  const pane = usePaneAccess()
  const usage = useApp(s => s.open.providerUsage)
  const activity = useApp(s => {
    for (let i = s.open.blocks.length - 1; i >= 0; i--) if (s.open.blocks[i]?.kind === 'turn_end') return s.open.blocks[i]!.at
    return undefined
  })
  const env = useComposer(s => s.settings?.providers[provider.kind]?.env)
  const global = useNav(s => s.limits.find(l => l.provider === provider.kind))
  const window = promptCacheWindow(provider.kind, env)
  const [now, setNow] = useState(Date.now)
  const remaining = activity && window ? promptCacheRemainingMinutes(activity, window.ttlMinutes, now) : 0
  useEffect(() => {
    if (!remaining || running || pane.frozen) return
    let timer: ReturnType<typeof setInterval> | undefined
    const sync = () => {
      if (isWindowVisible() && !timer) { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 15_000) }
      else if (!isWindowVisible() && timer) { clearInterval(timer); timer = undefined }
    }
    const stop = onWindowVisibility(sync)
    sync()
    return () => { stop(); if (timer) clearInterval(timer) }
  }, [remaining > 0, running, activity, pane.frozen])
  const cache = activity && window ? cacheState(!!running, remaining) : null
  const context = contextUsage(usage?.context)
  const limits = usage?.limits ?? (provider.instance === 'default' ? global?.limits : undefined)
  const binding = limits ? bindingLimit(limits, now) : null
  const tone = glyphTone(context?.percent ?? null, binding ? 100 - binding.used : null)
  const color = tone === 'critical' ? t.red : tone === 'warning' ? t.v('--warning') : t.textSecondary
  if (!context && !cache && !limits?.length) return null
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity=".2"/>${context ? `<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-dasharray="${context.percent * 0.5655} 56.55" stroke-linecap="round" transform="rotate(-90 12 12)"/>` : ''}${cache && cache.state !== 'cold' ? `<circle cx="12" cy="12" r="2.5" fill="currentColor" opacity="${cacheDotOpacity(cache)}"/>` : ''}</svg>`
  return <PickerMenu testId="composer-status" side="top" align="end" width={304} trigger={() => <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 14, cursor: 'pointer', hover: { backgroundColor: t.hover } }}><Icon source={source} size={16} color={color} /></div>}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12 }}>
      {cache && <><Label color={t.text} weight={500}>Prompt cache</Label><Label color={t.textSecondary}>{cache.state === 'active' ? 'Active' : cache.state === 'warm' ? `Warm · about ${remaining} minutes remain` : 'Cold'}</Label></>}
      {context && <><Label color={t.text} weight={500}>Context window</Label><Label color={t.textSecondary}>{`${Math.round(context.percent)}% used · ${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens`}</Label></>}
      {limits?.map((limit, i) => <Label key={i} color={t.textSecondary}>{`${limitLabel(limit, provider.kind)} · ${limitLeftLabel(limit, now)}`}</Label>)}
    </div>
  </PickerMenu>
}
