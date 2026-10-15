import '../../scripts/dock2-fixture.tsx'
import { getClient } from '../state.ts'
const client = getClient()!, call = client.call.bind(client)
client.call = (async (method: string, params: unknown) => {
  const result = await call(method as never, params as never)
  if (method !== 'computer.frame') return result
  const payload = result as { frame?: { seq: number; data: string } }
  if (payload.frame && Math.floor(payload.frame.seq / 4) % 2) payload.frame.data = Buffer.from(Buffer.from(payload.frame.data, 'base64').toString().replace('#3566b1', '#32764d')).toString('base64')
  return payload
}) as typeof client.call
