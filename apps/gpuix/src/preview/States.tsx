// Copy and state order mirror desktop PreviewStates.tsx.
import { useEffect, useState, type ReactNode } from 'react'
import { usePreview, retryPreview, setPreviewProxy, launchPreview, openPreview, setPreview } from './store.ts'
import { activeEnvironment } from '../shell/environment.ts'
import { isWindowVisible, onWindowVisibility } from '../native/visibility.ts'
import { copyText } from '../transcript/store.ts'
import { chooseTab, setDock } from '../dock/store.ts'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { glyph, Icon, ICONS } from '../icons.tsx'
import { Button } from '../kit/Button.tsx'
import { N } from '../nav/glyphs.ts'
import { Label, useTheme } from '../ui.tsx'
export function PreviewStateView({ threadId }: { threadId: string }) {
  const t = useTheme(), s = usePreview(threadId), entry = s.entries[s.index], load = s.load
  if (s.permission) return <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 24 }}>
    <Label color={t.text} size={13}>{s.permission.grantable ? 'Allow previewing files in this folder?' : "Kybern can't preview files from this folder"}</Label><Label color={t.textSecondary} size={11}>{s.permission.folder}</Label>
    <Label color={t.textSecondary} size={12} lineHeight={18}>{s.permission.grantable ? "Pages in this folder can run scripts in an isolated preview. They can't reach your other files or Kybern. Kybern remembers this folder." : 'Move the file into your project or a subfolder.'}</Label>
    <div style={{ display: 'flex', gap: 8 }}><Button size="sm" variant="ghost" onClick={() => setPreview(threadId, { permission: undefined })}>{s.permission.grantable ? 'Cancel' : 'Close'}</Button>{s.permission.grantable && <Button variant="primary" size="sm" disabled={s.busy} onClick={() => void openPreview(threadId, s.permission!.address, true)}>Allow folder</Button>}</div>
  </div>
  if (!entry) return null
  const host = entry.kind === 'file' ? entry.title : new URL(entry.address).host
  if (load.phase === 'waiting') return <Waiting threadId={threadId} url={entry.address} startedAt={load.startedAt} error={load.error} />
  if (load.phase === 'blocked') return <State icon={ICONS.shield} title={`${host} can't be shown in a panel`} body={`The page sends ${load.header.split('-').map(s => s[0]?.toUpperCase() + s.slice(1)).join('-')}: ${load.value}, so browsers only show it as its own tab.`}>
    <Button variant="primary" size="sm" onClick={() => void launchPreview(threadId)}>Open in browser</Button>{activeEnvironment().local && <><Button size="sm" testId="preview-allow-proxy" onClick={() => setPreviewProxy(threadId, true)}>Preview through Kybern</Button><Label color={t.textSecondary} size={11} lineHeight={16}>Kybern relays the page and removes the frame restriction. Cookies are kept separate from your browser.</Label></>}
  </State>
  if (load.phase === 'error') {
    const body = load.error === 'dns' ? "The address couldn't be found." : load.error === 'tls' ? "The certificate isn't trusted." : load.error === 'http_status' ? `The server returned ${load.status ?? 'an error'}.` : load.error === 'not_http' ? "This port doesn't serve web pages." : load.message ?? "The page didn't load. Try again."
    return <State icon={glyph(Alert02Icon)} title={entry.kind === 'file' ? "Can't open this page" : `Can't open ${host}`} body={body}>{load.error === 'tls' && <Button variant="primary" size="sm" onClick={() => void launchPreview(threadId)}>Open in browser</Button>}<Button size="sm" testId="preview-retry" onClick={() => void retryPreview(threadId)}>Try again</Button></State>
  }
  if (entry.kind === 'external') return <State title={entry.query ? `Searching for “${entry.query}” opens in your browser` : `${host} opens in your browser`} body="Kybern previews local files and dev servers. Other websites open in your default browser."><Button variant="primary" size="sm" testId="preview-open-browser" onClick={() => void launchPreview(threadId)}>{entry.query ? 'Search in browser' : 'Open in browser'}</Button></State>
  if (load.phase === 'not-found') return <State icon={N.folder} title={`${load.name} isn't there anymore`} body="It may have been moved or deleted."><Button variant="primary" size="sm" onClick={() => { chooseTab(threadId, 'explorer'); setDock(threadId, { open: true }) }}>Show folder in Explorer</Button></State>
  if (load.phase === 'relay-failed') return <State title={`Open this page on ${activeEnvironment().name}`} body="Kybern can't forward this server through the current connection."><Button size="sm" onClick={() => copyText(entry.address)}>Copy address</Button><Button variant="primary" size="sm" onClick={() => void launchPreview(threadId)}>Open in browser</Button><Button size="sm" onClick={() => void retryPreview(threadId)}>Try again</Button></State>
  return null
}
export function State({ title, body, children, icon = N.globe }: { title: string; body: string; children?: ReactNode; icon?: string }) {
  const t = useTheme()
  return <div testId="preview-state" style={{ display: 'flex', flexGrow: 1, minHeight: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}><div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 340 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, marginBottom: 12, backgroundColor: t.buttonSecondary }}><Icon source={icon} size={16} color={t.textSecondary} /></div>
    <Label color={t.text} size={13} lineHeight={18} weight={500} style={{ textAlign: 'center' }}>{title}</Label><Label color={t.textSecondary} size={12} lineHeight={18} style={{ textAlign: 'center', marginTop: 4 }}>{body}</Label>
    {children && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 12 }}>{children}</div>}
  </div></div>
}
function Waiting({ threadId, url, startedAt, error }: { threadId: string; url: string; startedAt: number; error: string }) {
  const t = useTheme(), [stopped, setStopped] = useState(Date.now() - startedAt >= 60_000), [visible, setVisible] = useState(isWindowVisible)
  useEffect(() => onWindowVisibility(setVisible), [])
  useEffect(() => {
    setStopped(Date.now() - startedAt >= 60_000)
    if (!visible || stopped || Date.now() - startedAt >= 60_000) return
    const timeout = setTimeout(() => { setStopped(true) }, Math.max(0, 60_000 - (Date.now() - startedAt)))
    const retry = setInterval(() => { void retryPreview(threadId) }, 2000)
    return () => { clearTimeout(timeout); clearInterval(retry) }
  }, [threadId, startedAt, visible, stopped])
  const u = new URL(url), port = u.port || (u.protocol === 'https:' ? '443' : '80'), hostname = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname
  return <State icon={glyph(Alert02Icon)} title={`Can't reach ${u.host}`} body={error === 'timed_out' ? "The server didn't answer within 1.5 seconds." : `Nothing is answering on port ${port}. Start the dev server and the page opens here when it's ready.`}>
    <Label color={t.textSecondary} size={11}>{stopped ? 'Stopped waiting.' : 'Waiting for the server…'}</Label><Label color={t.textSecondary} size={11}>{`${error === 'timed_out' ? 'ETIMEDOUT' : 'ECONNREFUSED'} ${hostname}:${port}`}</Label><Button size="sm" testId="preview-retry" onClick={() => { setStopped(false); void openPreview(threadId, url, false, false, true) }}>{stopped ? 'Try again' : 'Try now'}</Button>
  </State>
}
