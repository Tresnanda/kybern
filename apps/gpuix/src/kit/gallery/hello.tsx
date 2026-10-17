// Example section (harness smoke test): two switches at (40, 40).
import type { ComponentType } from 'react'
import { useTheme } from '../../ui.tsx'

function Hello() {
  const t = useTheme()
  return <div style={{ display: 'flex', padding: 40, gap: 16 }}><div style={{ width: 32, height: 20, borderRadius: 10, backgroundColor: t.v('--primary') }} /><div style={{ width: 32, height: 20, borderRadius: 10, backgroundColor: t.v('--input') }} /></div>
}
export const sections: Record<string, ComponentType> = { hello: Hello }
