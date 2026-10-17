import type { ComponentType } from 'react'
import { Switch } from '@/components/kit/switch'
function Hello() { return <div style={{ padding: 40, display: 'flex', gap: 16 }}><Switch defaultChecked /><Switch /></div> }
export const sections: Record<string, ComponentType> = { hello: Hello }
