// `kybern_request_secret`: the card that replaces the composer while an agent asks for
// one secret, and the quiet line the request leaves in the transcript. The value lives
// only in this card's state until it is sent with the answer; it is never logged,
// stored, or kept after the card closes. Kybern writes it to the file; the agent only
// learns whether it was saved.
import { memo, useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/kit/button"
import { ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import { Input } from "@/components/kit/input"
import { InputGroup, InputGroupAddon } from "@/components/kit/input-group"
import { TextSwap } from "@/components/kybern/motion"
import { CheckIcon, KeyIcon, LockIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { RpcCallError, type ApprovalDecision, type ApprovalRequest, type SecretRequestInput } from "@/protocol"
import { respondApproval } from "@/state/rpc"
import {
  SECRET_REQUEST_COPY,
  secretDestination,
  secretOutcome,
  secretOutcomeLine,
  secretPartsText,
  type SecretTextPart,
} from "../../../../packages/kybern-client/src/secretRequest"

// The transcript's own inline-code chip, so the file and key read the same everywhere.
const CODE_CLASS = "rounded-[0.4rem] bg-[var(--app-chat-code-surface)] px-[0.35em] py-px font-[family-name:var(--font-chat-code-family)] text-[0.92em] text-foreground/90"

/** Text with the file and key set as code. */
function SecretText({ parts }: { parts: readonly SecretTextPart[] }) {
  return <>{parts.map((part, index) => (part.code ? <code key={index} className={CODE_CLASS}>{part.text}</code> : <span key={index}>{part.text}</span>))}</>
}

export function SecretRequestPanel({ approval, input, count }: { approval: ApprovalRequest; input: SecretRequestInput; count: number }) {
  const field = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const titleId = useId()
  const detailId = useId()

  // The card asks for one thing; put the cursor there.
  useEffect(() => {
    field.current?.focus({ preventScroll: true })
  }, [])

  const respond = async (decision: ApprovalDecision) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await respondApproval(approval.id, decision)
      setValue("")
    } catch (failure) {
      // The daemon's own words when it refused the answer; otherwise the connection failed.
      setError(failure instanceof RpcCallError ? failure.message : "Unable to send your answer. Check the connection and try again.")
      setBusy(false)
    }
  }

  const save = () => {
    if (!value) {
      field.current?.focus()
      return
    }
    void respond({ decision: "submit", response: { secret: value } })
  }

  return (
    <ComposerStackedPanel
      className="composer-approval-panel t-panel-enter px-3.5 py-3"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={detailId}
      data-secret-request={input.env_key}
      onMouseDown={(event) => {
        // Clicking anywhere on the card that is not a control goes to the field.
        if ((event.target as HTMLElement).closest("button, a, input, [role='button']")) return
        event.preventDefault()
        field.current?.focus()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        autoComplete="off"
      >
        <div className="flex items-start gap-3">
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-muted-foreground">
            <KeyIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 pt-px">
            <p id={titleId} className="flex items-start gap-2 text-[13px] leading-snug font-medium text-balance text-foreground/90">
              <span className="min-w-0 break-words">{input.label}</span>
              {count > 1 && (
                <span className="mt-px flex h-4 shrink-0 items-center rounded bg-[var(--color-background-elevated-secondary)] px-1 text-[9.5px] font-medium text-[var(--color-text-foreground-secondary)] tabular-nums">
                  1/{count}
                </span>
              )}
            </p>
            <div id={detailId}>
              {input.reason && <p className="mt-0.5 text-[12px] leading-relaxed text-pretty text-muted-foreground/65">{input.reason}</p>}
              <p className="mt-1.5 text-[11.5px] leading-relaxed break-words text-muted-foreground/70">
                <SecretText parts={secretDestination(input)} />
              </p>
            </div>
          </div>
        </div>
        <InputGroup className="mt-2.5 h-8.5 border-[var(--color-border)] bg-[var(--color-background-control-opaque)] has-[input:focus]:border-foreground/30">
          <Input
            unstyled
            nativeInput
            ref={field}
            type="text"
            name="kybern-secret-value"
            aria-label={`${input.label} value`}
            aria-invalid={error ? true : undefined}
            placeholder={input.placeholder ?? undefined}
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              // Esc leaves the field; it never declines the request.
              if (event.key === "Escape") {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            className={cn("font-mono text-[13px]", !shown && value && "tracking-[0.12em]")}
            style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
          />
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-pressed={shown}
              aria-label={shown ? "Hide the value" : "Show the value"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setShown(!shown)}
            >
              {shown ? "Hide" : "Show"}
            </Button>
          </InputGroupAddon>
        </InputGroup>
        {error && <p role="alert" className="mt-1.5 text-[12px] leading-relaxed text-destructive">{error}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <p className="me-auto flex min-w-48 flex-1 items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/65">
            <LockIcon aria-hidden className="size-3 shrink-0" />
            <span className="text-pretty">{SECRET_REQUEST_COPY.footnote}</span>
          </p>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void respond({ decision: "deny" })}>
            {SECRET_REQUEST_COPY.decline}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !value}>
            <TextSwap text={busy ? SECRET_REQUEST_COPY.saving : SECRET_REQUEST_COPY.save} />
            <kbd className="text-[0.85em] opacity-60" aria-hidden="true">↵</kbd>
          </Button>
        </div>
      </form>
    </ComposerStackedPanel>
  )
}

/** The settled request in the transcript: one quiet line, never the value. */
export const SecretRequestLine = memo(function SecretRequestLine({ input, decision, style }: { input: SecretRequestInput; decision: ApprovalDecision | null; style?: React.CSSProperties }) {
  const outcome = secretOutcome(decision)
  const parts = secretOutcomeLine(input, decision)
  return (
    <div className="rounded-lg py-1" data-secret-outcome={outcome}>
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {outcome === "saved" ? <CheckIcon className="size-4 text-[var(--color-success)]" /> : <KeyIcon className="size-4" />}
        </span>
        <p className="min-w-0 truncate leading-6 text-muted-foreground" style={style} title={secretPartsText(parts)}>
          <SecretText parts={parts} />
        </p>
      </div>
    </div>
  )
})
