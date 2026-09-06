import { createContext, useCallback, useContext, useState, type Dispatch, type SetStateAction } from "react"

export interface TranscriptRowState {
  values: Map<string, unknown>
  scope: string
}

export const TranscriptRowStateContext = createContext<TranscriptRowState | null>(null)

/** Keep small user choices across virtual row unmounts. The owning transcript
 * releases the map on thread change; parsed/highlighted content is not stored. */
export function useTranscriptRowState<T>(name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(TranscriptRowStateContext)
  const key = `${context?.scope ?? ""}/${name}`
  const values = context?.values
  const [state, setState] = useState(() => ({ key, values, value: values?.has(key) ? values.get(key) as T : initial }))
  if (state.key !== key || state.values !== values) {
    setState({ key, values, value: values?.has(key) ? values.get(key) as T : initial })
  }
  const update = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    setState((current) => {
      const next = typeof action === "function" ? (action as (value: T) => T)(current.value) : action
      values?.set(key, next)
      return { key, values, value: next }
    })
  }, [key, values])
  return [state.value, update]
}
