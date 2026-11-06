import { useEffect, useState } from 'react'
import { asError } from '../../../../packages/kybern-client/src/problem.ts'
import type { Methods } from '../../../../packages/kybern-client/src/types.ts'
import { getClient, useApp } from '../state.ts'

/** Reads only while this section is mounted, and re-reads on reconnection. No idle polling. */
export function useResource<M extends keyof Methods>(method: M, params: Methods[M][0], enabled = true) {
  const connection = useApp((s) => s.status)
  const [state, setState] = useState<{ data: Methods[M][1] | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true })
  const [generation, setGeneration] = useState(0)
  const key = JSON.stringify(params)
  useEffect(() => {
    const client = getClient()
    if (!client || connection !== 'open' || !enabled) return
    let live = true
    setState({ data: null, error: null, loading: true })
    void client.call(method, JSON.parse(key)).then((data) => { if (live) setState({ data, error: null, loading: false }) }, (error) => { if (live) setState({ data: null, error: asError(error), loading: false }) })
    return () => { live = false }
  }, [method, key, enabled, generation, connection])
  return { ...state, refresh: () => setGeneration((v) => v + 1) }
}
