import { SvgXml } from 'react-native-svg'
import { useContext, useEffect, useState } from 'react'
import { Image } from 'react-native'
import { classifyLink, linkStateColor, type LinkMetadata } from '../../../../packages/kybern-client/src/linkIcons'
import { ChatFileContext } from '../state/chatFileContext'
import { machineClient, ownerMachine } from '../state/machineRequests'
import { Icon } from './primitives'
import { useTheme } from './theme'
const cache = new Map<string, { until: number; value: LinkMetadata }>()
export function ReplyLinkIcon({ href }: { href: string }) {
  const context = useContext(ChatFileContext), { colors } = useTheme()
  const kind = classifyLink(href).kind
  const [data, setData] = useState<LinkMetadata>({})
  useEffect(() => {
    let live = true
    if (!['web', 'issue', 'pull'].includes(kind)) return
    const machine = ownerMachine({ threadId: context?.threadId }), client = machineClient(machine)
    if (!client) return
    const key = `${machine}:${href}`, known = cache.get(key)
    if (known && known.until > Date.now()) { setData(known.value); return }
    void client.fetch(`/links/icon?url=${encodeURIComponent(href)}`).then(async response => response.ok ? await response.json() as LinkMetadata : {}).catch(() => ({})).then(value => {
      if (cache.size >= 256) cache.delete(cache.keys().next().value!)
      cache.set(key, { until: Date.now() + 300_000, value })
      if (live) setData(value)
    })
    return () => { live = false }
  }, [href, kind, context?.threadId])
  if (kind === 'none') return null
  if (kind === 'web' && data.favicon) return <Image source={{ uri: data.favicon }} style={{ width: 14, height: 14 }} />
  if (kind === 'github') return <SvgXml width={14} height={14} xml={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="${colors.secondary}" d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.49c-2.23.49-2.7-.95-2.7-.95-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.22.83 1.22.83.71 1.22 1.87.87 2.33.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.96 0-.88.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.22 2.2.82a7.65 7.65 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.08-1.87 3.75-3.65 3.95.29.25.54.74.54 1.49v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 0Z"/></svg>`} />
  return <Icon name={kind === 'file' ? 'doc' : kind === 'pull' ? 'arrow.triangle.pull' : kind === 'issue' ? 'circle.dotted' : 'globe'} size={14} color={linkStateColor(data.state) ?? colors.secondary} />
}
