import { Label, useTheme } from '../ui.tsx'
export function AgentsScene() {
  const t = useTheme()
  return <div style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Label color={t.text} size={20}>AgentsScene</Label></div>
}
