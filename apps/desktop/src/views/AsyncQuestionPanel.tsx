import { useId, useState } from "react"
import { TextSwap } from "@/components/kybern/motion"
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
  return <ComposerStackedPanel className="question-panel overflow-hidden !rounded-b-xl border-b">
    <form className="question-panel-form" aria-label="Answer agent questions" aria-busy={busy} onSubmit={async (event) => {
      event.preventDefault()
      if (busy || !ready) return
      setBusy(true)
      setError("")
      try {
        await rpc().call("threads.answer", { thread_id: threadId, request_id: request.id, answers: request.questions.map((_, index) => answers[index]!.trim()) })
      } catch (error) { setError(errorText(error)) }
      finally { setBusy(false) }
    }}>
      <div className="question-panel-header">
        <h2>{request.questions.length === 1 ? "Question" : "Questions"}</h2>
        {count > 1 && <span className="question-panel-count">{count} requests</span>}
      </div>
      <fieldset disabled={busy} className="question-panel-body">
        {request.questions.map((question, index) => <fieldset key={index} className="question-panel-question">
          <legend className="question-panel-title">{request.questions.length > 1 && <span className="question-panel-number">{index + 1}. </span>}{question.title}</legend>
          {question.options.map((option, optionIndex) => <label key={optionIndex} className="question-panel-option">
            <input type="radio" name={`${id}:${index}`} checked={!custom[index] && answers[index] === option} className="question-panel-choice" onChange={() => {
              setAnswers((previous) => ({ ...previous, [index]: option }))
              setCustom((previous) => ({ ...previous, [index]: false }))
            }} />
            <span className="min-w-0 leading-relaxed">{option}</span>
          </label>)}
          <label className="question-panel-answer"><span>{question.options.length ? "Or write an answer" : "Your answer"}</span><textarea rows={3} autoComplete="off" value={custom[index] ? answers[index] ?? "" : ""} className="question-panel-field" onChange={(event) => {
            setAnswers((previous) => ({ ...previous, [index]: event.target.value }))
            setCustom((previous) => ({ ...previous, [index]: true }))
          }} /></label>
        </fieldset>)}
      </fieldset>
      {error && <p role="alert" className="question-panel-error">{error}</p>}
      <div className="question-panel-footer">
        <p className="question-panel-hint">The agent keeps working while you answer.</p>
        <Button type="submit" size="sm" disabled={busy || !ready}><TextSwap text={busy ? "Sending…" : request.questions.length > 1 ? "Send answers" : "Send answer"} /></Button>
      </div>
    </form>
  </ComposerStackedPanel>
}
