import { useId, useState } from "react"
import { QuestionSteps } from "./QuestionSteps"
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
  return <QuestionSteps count={count} busy={busy} error={error}
    hint="The agent keeps working while you answer."
    questions={request.questions.map((question, index) => ({ id: String(index), title: question.title, answers: answers[index]?.trim() ? [answers[index]!] : [] }))}
    onSend={async () => {
      if (busy || !ready) return
      setBusy(true)
      setError("")
      try {
        await rpc().call("threads.answer", { thread_id: threadId, request_id: request.id, answers: request.questions.map((_, index) => answers[index]!.trim()) })
      } catch (error) { setError(errorText(error)) }
      finally { setBusy(false) }
    }} renderQuestion={index => {
      const question = request.questions[index]!
      return <fieldset className="question-panel-question">
          <legend className="question-panel-title">{question.title}</legend>
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
        </fieldset>
    }} />
}
