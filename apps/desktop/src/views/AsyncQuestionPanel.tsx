import { useId, useState } from "react"
import { Button } from "@/components/kit/button"
import { ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import type { AsyncQuestionRequest, ThreadId } from "@/protocol"
import { errorText, rpc } from "@/state/rpc"

/** Async questions remain open while the agent works; selection never submits. */
export function AsyncQuestionPanel({ threadId, request, count }: { threadId: ThreadId; request: AsyncQuestionRequest; count: number }) {
  const id = useId()
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [custom, setCustom] = useState<Record<number, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const ready = request.questions.every((_, index) => answers[index]?.trim())
  return <ComposerStackedPanel className="overflow-hidden !rounded-b-xl">
    <form className="flex max-h-[45dvh] flex-col text-[length:var(--app-font-size-ui)]" onSubmit={async (event) => {
      event.preventDefault()
      if (busy || !ready) return
      setBusy(true)
      setError("")
      try {
        await rpc().call("threads.answer", { thread_id: threadId, request_id: request.id, answers: request.questions.map((_, index) => answers[index]!.trim()) })
      } catch (error) { setError(errorText(error)) }
      finally { setBusy(false) }
    }}>
      <div className="px-4 pt-4 pb-3">
        <h2 className="font-semibold text-foreground">{count > 1 ? `Questions for you · ${count} requests` : "A question for you"}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The agent can keep working while you answer.</p>
      </div>
      <fieldset disabled={busy} className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-4 pb-3">
        {request.questions.map((question, index) => <fieldset key={index} className="space-y-2">
          <legend className="mb-2 leading-relaxed font-medium text-foreground">{question.title}</legend>
          {question.options.map((option, optionIndex) => <label key={optionIndex} className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-background-button-secondary)] px-3 py-2 has-checked:ring-1 has-checked:ring-[var(--color-border-focus)]">
            <input type="radio" name={`${id}:${index}`} checked={!custom[index] && answers[index] === option} className="mt-1 accent-[var(--color-text-foreground)]" onChange={() => {
              setAnswers((previous) => ({ ...previous, [index]: option }))
              setCustom((previous) => ({ ...previous, [index]: false }))
            }} />
            <span className="min-w-0 leading-relaxed">{option}</span>
          </label>)}
          <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{question.options.length ? "Write an answer" : "Answer"}</span><input autoComplete="off" value={custom[index] ? answers[index] ?? "" : ""} className="w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => {
            setAnswers((previous) => ({ ...previous, [index]: event.target.value }))
            setCustom((previous) => ({ ...previous, [index]: true }))
          }} /></label>
        </fieldset>)}
      </fieldset>
      {error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
      <div className="flex shrink-0 justify-end border-t border-[var(--color-border)] px-4 py-3"><Button type="submit" size="sm" disabled={busy || !ready}>{busy ? "Sending…" : "Submit answer"}</Button></div>
    </form>
  </ComposerStackedPanel>
}
