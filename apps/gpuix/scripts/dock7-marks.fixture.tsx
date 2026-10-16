import '../src/native/local-build.ts'
import { render } from '@gpuix/react'
import { Label, ProviderMark, ThemeProvider, useTheme } from '../src/ui.tsx'
const kinds = ['claude-code', 'codex', 'opencode', 'pi', 'omp', 'cursor', 'devin', 'antigravity', 'grok', 'droid']
const surfaces = [['Sidebar', 12], ['Model / account tabs', 14], ['Thread header', 14], ['Hand off', 16], ['Subagent row / hover', 12], ['Settings agents', 14], ['Settings accounts', 18], ['Usage ring / hover', 11], ['Palette', 15]] as const
function Sheet() {
  const t = useTheme()
  return <div testId="app-ready" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: t.surface, paddingTop: 44 }}>
    <div style={{ display: 'flex', height: 60, alignItems: 'center', paddingLeft: 24 }}><Label size={18} weight={600} color={t.text}>Provider marks · desktop surface sizes</Label></div>
    <div style={{ display: 'flex', height: 48, alignItems: 'center', paddingLeft: 24 }}><div style={{ width: 210 }} />{kinds.map(kind => <div key={kind} style={{ display: 'flex', width: 100, justifyContent: 'center' }}><Label size={11} color={t.textSecondary}>{kind}</Label></div>)}</div>
    {surfaces.map(([surface, size]) => <div key={surface} style={{ display: 'flex', alignItems: 'center', height: 56, paddingLeft: 24, borderTopWidth: 0.5, borderColor: t.borderLight }}><div style={{ width: 210 }}><Label color={t.textSecondary} size={12}>{`${surface} · ${size}px`}</Label></div>{kinds.map(kind => <div key={kind} testId={`mark-${surface}-${kind}`} style={{ width: 100, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><ProviderMark kind={kind} size={size} tone={surface === 'Thread header' ? 'header' : 'default'} /></div>)}</div>)}
    <div style={{ padding: 24 }}><Label size={12} color={t.textSecondary}>Same ProviderMark component used by all app surfaces. Multicolour assets retain their source colours.</Label></div>
  </div>
}
render(<ThemeProvider><Sheet /></ThemeProvider>, { title: 'Dock7 provider marks', width: 1280, height: 820, focus: false })
