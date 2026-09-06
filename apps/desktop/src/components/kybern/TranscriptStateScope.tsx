import { useContext, useMemo, type ReactNode } from "react"
import { TranscriptRowStateContext } from "@/lib/transcriptRowState"

export function TranscriptStateRoot({ children }: { children: ReactNode }) {
  const value = useMemo(() => ({ values: new Map<string, unknown>(), scope: "" }), [])
  return <TranscriptRowStateContext value={value}>{children}</TranscriptRowStateContext>
}

export function TranscriptStateScope({ name, children }: { name: string; children: ReactNode }) {
  const parent = useContext(TranscriptRowStateContext)
  const value = useMemo(() => parent ? { values: parent.values, scope: `${parent.scope}/${name}` } : null, [parent, name])
  return <TranscriptRowStateContext value={value}>{children}</TranscriptRowStateContext>
}
