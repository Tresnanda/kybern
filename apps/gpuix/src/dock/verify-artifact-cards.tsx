// Entry for verify-artifact-cards.ts: the real app with `threads.artifacts.list` answered from recorded receipts.
import { getClient } from '../state.ts'
import { ARTIFACTS } from './artifact-fixture.mjs'
import '../main.tsx'
while (!getClient()) await Bun.sleep(20)
const client = getClient()!, call = client.call.bind(client)
client.call = (async (method: string, params: unknown) => method === 'threads.artifacts.list' ? { artifacts: ARTIFACTS, next_before_seq: null } : call(method as never, params as never)) as typeof client.call
