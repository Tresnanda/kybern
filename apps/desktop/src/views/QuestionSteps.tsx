import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/kit/button"
import { ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import { TextSwap } from "@/components/kybern/motion"
import { ArrowLeftIcon, ArrowRightIcon, PencilIcon, CircleQuestionIcon } from "@/lib/kit/icons"

interface QuestionStep {
  id: string
  title: string
  answers: string[]
  secret?: boolean
}

/** Keep response encoding in each harness adapter; this owns only the review flow. */
export function QuestionSteps({ questions, renderQuestion, busy, error, hint, count, blocking, onSend, onDecline }: {
  questions: QuestionStep[]
  renderQuestion: (index: number) => ReactNode
  busy: boolean
  error: string
  hint: string
  count: number
  blocking?: boolean
  onSend: () => void
  onDecline?: () => void
}) {
  const [step, setStep] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const previousStep = useRef(step)
  const reviewing = step === questions.length
  const ready = questions.every(question => question.answers.some(answer => answer.trim()))
  const canContinue = reviewing ? ready : questions[step]?.answers.some(answer => answer.trim())
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus({ preventScroll: true })
    previousStep.current = step
  }, [step])

  return <ComposerStackedPanel className="question-panel t-panel-enter overflow-hidden">
    <form className={`question-panel-form${blocking ? " question-panel-form-blocking" : ""}`} aria-label="Answer agent questions" aria-busy={busy} onSubmit={event => {
      event.preventDefault()
      if (busy || !canContinue) return
      if (reviewing) onSend()
      else setStep(step + 1)
    }}>
      <div className="question-panel-header">
        <h2 ref={heading} tabIndex={-1} className="question-step-heading"><CircleQuestionIcon className="size-4" />{reviewing ? "Review answers" : "Your input"}</h2>
        <span className="question-panel-count" aria-live="polite">{reviewing ? `${questions.length} answered` : `Question ${step + 1} of ${questions.length}`}{count > 1 ? ` · ${count} requests` : ""}</span>
      </div>
      <fieldset disabled={busy} className="question-panel-body" key={step}>
        {reviewing ? <ol className="question-review-list">{questions.map((question, index) => <li key={question.id} className="question-review-item">
          <div className="min-w-0">
            <p className="question-review-title">{question.title}</p>
            <p className="question-review-answer">{question.secret ? "Hidden answer" : question.answers.join("\n")}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Edit answer ${index + 1}`} onClick={() => setStep(index)}><PencilIcon /></Button>
        </li>)}</ol> : renderQuestion(step)}
      </fieldset>
      {error && <p role="alert" className="question-panel-error">{error}</p>}
      <div className="question-panel-footer">
        <p className="question-panel-hint">{reviewing ? "Check your answers before sending." : hint}</p>
        <div className="question-panel-actions">
          {onDecline && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDecline}>Decline</Button>}
          {step > 0 && <Button type="button" variant="chrome-outline" size="sm" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeftIcon className="rtl:rotate-180" />Previous</Button>}
          <Button type="submit" size="sm" disabled={busy || !canContinue}><TextSwap text={busy ? "Sending…" : reviewing ? questions.length === 1 ? "Send answer" : "Send answers" : step === questions.length - 1 ? "Review answers" : "Next"} />{!reviewing && <ArrowRightIcon className="rtl:rotate-180" />}</Button>
        </div>
      </div>
    </form>
  </ComposerStackedPanel>
}
