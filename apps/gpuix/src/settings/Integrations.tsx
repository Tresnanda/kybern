// Settings › Integrations: `views/Integrations.tsx`. Plugins and connectors for Claude Code
// and Codex in one project: agent and project pickers, Add connector and Refresh, the
// Plugins/Connectors switch with search, and one card row per integration with its
// actions, Connect and Sign in chips.
import { useEffect, useState } from 'react'
import type { Integration, IntegrationAction, IntegrationsCatalog, ProviderKind } from '../../../../packages/kybern-client/src/types.ts'
import { Icon } from '../icons.tsx'
import { N } from '../nav/glyphs.ts'
import { errorText } from '../nav/actions.ts'
import { setNav } from '../nav/store.ts'
import { chooseTab, setDock } from '../dock/store.ts'
import { Segments } from '../usage/controls.tsx'
import { getClient, useApp } from '../state.ts'
import { Label, useTheme } from '../ui.tsx'
import { GlassEdge } from '../kit/GlassEdge.tsx'
import { settingsCardStyle, useGlass } from '../platform/glass.ts'
import { Button, PageBlock, Select, TextField } from './controls.tsx'
import { openExternal } from './external.ts'
import { S } from './glyphs.ts'

const LABELS: Record<IntegrationAction, string> = { install: 'Install', uninstall: 'Uninstall', enable: 'Enable', disable: 'Disable', update: 'Update' }
const CONNECTORS_URL = 'https://claude.ai/settings/connectors'

export function Integrations() {
  const t = useTheme()
  const g = useGlass()
  const projects = useApp((s) => s.projects)
  const connected = useApp((s) => s.status === 'open')
  const thread = useApp((s) => s.threads.find((th) => th.id === s.selectedId))
  const draftProject = useApp((s) => (s.selectedId ? undefined : s.draft.projectId))
  const [projectId, setProjectId] = useState(thread?.project_id ?? draftProject ?? projects[0]?.id ?? '')
  const [provider, setProvider] = useState<ProviderKind>(thread?.provider.kind === 'codex' ? 'codex' : 'claude-code')
  const [category, setCategory] = useState<'plugin' | 'connector'>('plugin')
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<IntegrationsCatalog>({ items: [], warnings: [] })
  const [loadedKey, setLoadedKey] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [count, setCount] = useState(40)
  const requestKey = `${projectId}:${provider}:${refresh}:${connected}`
  const loading = !!projectId && connected && loadedKey !== requestKey
  useEffect(() => {
    const client = getClient()
    if (!projectId || !connected || !client) return
    let alive = true
    void client.call('integrations.list', { project_id: projectId, provider })
      .then((value) => { if (alive) { setCatalog(value); setError('') } })
      .catch((e) => { if (alive) setError(errorText(e)) })
      .finally(() => { if (alive) setLoadedKey(requestKey) })
    return () => { alive = false }
  }, [projectId, provider, refresh, connected, requestKey])
  const matches = (loading ? [] : catalog.items).filter((item) => item.kind === category && `${item.name} ${item.id} ${item.description ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  const change = async (item: Integration, action: IntegrationAction) => {
    const client = getClient()
    if (!client) return
    setBusy(item.id); setError(''); setNotice('')
    try {
      const result = await client.call('integrations.change', { project_id: projectId, provider, id: item.id, kind: item.kind, scope: item.scope, action })
      setNotice(result.message)
      if (result.connections.length) {
        setCategory('connector')
        setNotice(`${result.message} Open the connector setup links to finish signing in.`)
        setCatalog((value) => ({ ...value, items: [...result.connections, ...value.items.filter((existing) => !result.connections.some((app) => app.id === existing.id))] }))
      } else setRefresh((value) => value + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }
  const onThisProject = !!thread && thread.provider.kind === provider && thread.project_id === projectId
  const login = async (item: Integration) => {
    const client = getClient()
    if (!thread || !onThisProject || !client) return
    setBusy(item.id); setError('')
    try {
      await client.call('integrations.login', { thread_id: thread.id, name: item.id })
      if (getClient() !== client) return
      chooseTab(thread.id, 'terminal')
      setDock(thread.id, { open: true })
      setNav({ settingsOpen: false })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }
  const openConnectors = () => void openExternal(CONNECTORS_URL).catch((e) => setError(errorText(e)))
  const noun = category === 'plugin' ? 'plugin' : 'connector'
  const canSignIn = provider === 'claude-code' && category === 'connector'
  const emptyTitle = !projectId ? 'Select a project' : !connected ? 'Not connected' : query ? 'No matches' : `No ${noun}s yet`
  const emptyBody = !projectId ? 'Choose a project to manage its plugins and connectors.' : !connected ? 'Connect your computer to load integrations.' : query ? `Nothing matches “${query}”. Try a different search.` : category === 'plugin' ? 'Install a plugin skill in your agent, then refresh to see it here.' : 'Connect an app in your agent, then refresh to see it here.'
  return <PageBlock><div testId="integrations" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Select compact testId="integrations-agent" label="Agent" value={provider} disabled={!!busy} onChange={(value) => { setProvider(value as ProviderKind); setNotice('') }} options={[{ value: 'claude-code', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
      <Select compact testId="integrations-project" label="Project" value={projectId} disabled={!!busy} onChange={setProjectId} options={projects.length ? projects.map((p) => ({ value: p.id, label: p.name })) : [{ value: '', label: 'Select project' }]} />
      <div style={{ flexGrow: 1 }} />
      {canSignIn && <Button testId="integrations-add-connector" variant="ghost" icon={S.externalLink} onClick={openConnectors}>Add connector</Button>}
      <Button testId="integrations-refresh" variant="ghost" icon={S.refresh} disabled={!connected || loading || !!busy} onClick={() => setRefresh((value) => value + 1)}>{loading ? 'Loading…' : 'Refresh'}</Button>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Segments testId="integrations-kind" value={category} width={[65, 90]} fontSize={12} options={[['plugin', 'Plugins'], ['connector', 'Connectors']]} onChange={(value) => { setCategory(value); setCount(40) }} />
      <div style={{ flexGrow: 1, position: 'relative' }}>{/* `InputGroup`: `border-input` (white in light, so no visible edge) on `bg-background` / `dark:bg-input/32`. */}<TextField testId="integrations-search" label="Find integrations" placeholder={`Find a ${noun}`} value={query} onChange={(value) => { setQuery(value); setCount(40) }} width="100%" style={{ borderColor: t.v('--input'), backgroundColor: t.inputGroupFill, fontSize: 14, paddingLeft: 30 }} /><div style={{ position: 'absolute', left: 10, top: 8, pointerEvents: 'none' }}><Icon source={N.search} size={14} color={t.textSecondary} /></div></div>
    </div>
    <Label color={t.textSecondary} size={12} lineHeight={19.5}>{provider === 'codex' ? 'Type @ in a conversation to choose an installed plugin or connected app.' : 'Type / in a conversation to choose a plugin skill, such as /plugin:skill.'}</Label>
    {notice && <Label color={t.textSecondary} size={12} lineHeight={19.5}>{notice}</Label>}
    {error && <Label color={t.v('--destructive')} size={12} lineHeight={19.5}>{error}</Label>}
    {catalog.warnings.map((message) => <Label key={message} color={t.textSecondary} size={12} lineHeight={19.5}>{message}</Label>)}
    {loading ? <Skeleton />
      : !matches.length ? <div testId="integrations-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, paddingTop: 30, paddingBottom: 30 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36, borderRadius: 12, backgroundColor: t.buttonSecondary }}><Icon source={category === 'plugin' ? S.plugin : S.mcp} size={18} color={t.textSecondary} /></div>
        <Label color={t.text} size={13} lineHeight={20.8} weight={500}>{emptyTitle}</Label>
        <Label color={t.textSecondary} size={13} lineHeight={20.8} style={{ maxWidth: 380 }}>{emptyBody}</Label>
        {query ? <Button variant="outline" onClick={() => setQuery('')}>Clear search</Button> : canSignIn ? <Button variant="outline" onClick={openConnectors}>Add a Claude connector</Button> : null}
      </div>
      : <div testId="integrations-list" style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
        {matches.slice(0, count).map((item, index) => {
          const canSignInHere = item.can_login && !onThisProject
          return <div key={`${item.kind}:${item.id}:${item.scope}`} testId={`integration-${item.id}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16, borderTopWidth: index ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, marginTop: 2, flexShrink: 0, borderRadius: 8, backgroundColor: t.buttonSecondary }}><Icon source={item.kind === 'plugin' ? S.plugin : S.mcp} size={16} color={t.textSecondary} /></div>
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 }}>
                <Label color={t.text} size={14} lineHeight={21} weight={500}>{item.name}</Label>
                {item.installed && <div style={{ display: 'flex', alignItems: 'center', height: 20, paddingLeft: 8, paddingRight: 8, borderRadius: 10, backgroundColor: t.v('--color-background-elevated-secondary') }}><Label color={t.textSecondary} size={11} lineHeight={16.5}>{item.enabled === false ? 'Disabled' : 'Installed'}</Label></div>}
              </div>
              {item.description && <Label color={t.textSecondary} size={12} lineHeight={19.5} style={{ marginTop: 4 }}>{item.description}</Label>}
              <Label color={t.textSecondary} size={11} lineHeight={16.5} style={{ marginTop: 6 }}>{`${item.status}${item.scope ? ` · ${item.scope}` : ''}`}</Label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {item.actions.map((action) => <Button key={action} testId={`integration-${item.id}-${action}`} size="chip" variant="subtle" disabled={!connected || !!busy} onClick={() => void change(item, action)}>{busy === item.id ? 'Working…' : LABELS[action]}</Button>)}
                {item.connect_url && <Button size="chip" variant="subtle" onClick={() => void openExternal(item.connect_url!).catch((e) => setError(errorText(e)))}>{item.installed ? 'Manage connection' : 'Connect'}</Button>}
                {item.can_login && <Button testId={`integration-login-${item.id}`} size="chip" variant="subtle" disabled={!connected || !!busy || !onThisProject} onClick={() => void login(item)}>Sign in</Button>}
              </div>
              {canSignInHere && <Label color={t.textSecondary} size={12} lineHeight={19.5} style={{ marginTop: 8 }}>Open a Claude conversation in this project to sign in.</Label>}
            </div>
          </div>
        })}
      </div>}
    {matches.length > count && <div style={{ display: 'flex' }}><Button variant="ghost" onClick={() => setCount((value) => value + 40)}>Show more</Button></div>}
  </div></PageBlock>
}

/** Three placeholder rows while the catalog loads (`animate-pulse` rows). */
function Skeleton() {
  const t = useTheme()
  const g = useGlass()
  const tint = t.buttonSecondary
  return <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', ...settingsCardStyle(t, g), overflow: 'hidden' }}><GlassEdge radius={12} color={g.highlight} />
    {[0, 1, 2].map((row) => <div key={row} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingLeft: 18, paddingRight: 18, paddingTop: 16, paddingBottom: 16, borderTopWidth: row ? 1 : 0, borderColor: t.v('--app-settings-card-border') }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: tint, flexShrink: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2, flexGrow: 1 }}><div style={{ width: 160, height: 14, borderRadius: 4, backgroundColor: tint }} /><div style={{ width: 352, maxWidth: '100%', height: 12, borderRadius: 4, backgroundColor: tint }} /></div>
    </div>)}
  </div>
}
