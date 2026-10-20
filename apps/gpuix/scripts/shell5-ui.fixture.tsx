import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { useState } from 'react'
import { connect, useApp } from '../src/state.ts'
import { TerminalPane } from '../src/terminal/Terminal.tsx'
import { ComposerView } from '../src/Composer.tsx'
import { ThemeProvider, Label, useTheme } from '../src/ui.tsx'
import { useNav } from '../src/nav/store.ts'
import { onWindowKeyDown } from '../src/nav/keys.ts'

connect()
function Fixture() {
  const t = useTheme(), status = useApp(s => s.status)
  const [composer, showComposer] = useState(false)
  const sessions = useNav(s => s.sessions), settings = useNav(s => s.settingsOpen), page = useNav(s => s.page)
  return <div testId="shell5-ready" style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.surface }}>
    <div testId="show-composer" onClick={() => showComposer(true)} style={{ padding: 10, backgroundColor: t.buttonSecondary }}><Label color={t.text}>Show draft</Label></div>
    <text testId="shell5-nav" style={{ color: t.text }}>{JSON.stringify({ sessions, settings, page, status })}</text>
    {composer ? <><div style={{ flexGrow: 1 }} /><ComposerView draftKey="shell5" provider={null} providers={[]} accounts={[]} mode="supervised" onModeChange={() => {}} onSend={async () => {}} catalogLoading={false} onReloadModels={async () => {}} /></> : status === 'open' && <TerminalPane threadId="fixture" width={720} />}
  </div>
}
render(<ThemeProvider><Fixture /></ThemeProvider>, { title: 'Shell verification', width: 720, height: 560, focus: false, onKeyDown: onWindowKeyDown })
