import { useId, useState } from "react"
import { Button } from "@/components/kit/button"
import { ComposerStackedPanel } from "@/components/kit/chat/ComposerStackedPanel"
import { array, questionResponse, questionsFor, record, string } from "@/lib/userInput"
import { openExternal } from "@/lib/tauri"
import type { ApprovalRequest } from "@/protocol"
import { errorText, respondApproval } from "@/state/rpc"

const FIELD = "w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-control-opaque)] px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function UserInputPanel({ approval, count }: { approval: ApprovalRequest; count: number }) {
  const id = useId()
  const input = record(approval.input)
  const questions = questionsFor(approval)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [value, setValue] = useState(string(input.prefill ?? input.value))
  const [urlOpened, setUrlOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const elicitation = approval.tool_name === "mcp_elicitation"
  const url = string(input.url)
  const isUrl = elicitation && input.mode === "url"
  const schema = record(input.requestedSchema ?? input.requested_schema)
  const properties = record(schema.properties)
  const required = array(schema.required)

  const submit = async (response?: unknown) => {
    if (busy) return
    setBusy(true)
    setError("")
    try {
      await respondApproval(approval.id, response === undefined ? { decision: "deny" } : { decision: "submit", response })
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    try {
      if (questions.length) {
        void submit(questionResponse(approval, questions.map((q) => custom[q.id]?.trim() ? [...(q.multiple ? selected[q.id] ?? [] : []), custom[q.id]!.trim()] : selected[q.id] ?? [])))
      } else if (elicitation) {
        const data = new FormData(event.currentTarget)
        const content: Record<string, unknown> = {}
        for (const [key, raw] of Object.entries(properties)) {
          const spec = record(raw)
          const values = data.getAll(`field:${key}`).map(String)
          const value = values[0] ?? ""
          if (!value && !required.includes(key)) continue
          if (spec.type === "boolean") content[key] = value === "true"
          else if (spec.type === "number" || spec.type === "integer") content[key] = Number(value)
          else if (spec.type === "array" && array(record(spec.items).enum).length) content[key] = values
          else if (spec.type === "object" || spec.type === "array") content[key] = JSON.parse(value)
          else content[key] = value
        }
        void submit({ action: "accept", ...(isUrl ? {} : { content }) })
      } else void submit({ value })
    } catch (error) { setError(errorText(error)) }
  }

  return <ComposerStackedPanel className="overflow-hidden !rounded-b-xl">
    <form onSubmit={onSubmit} className="flex max-h-[min(32rem,65dvh)] flex-col text-[length:var(--app-font-size-ui)]">
      <div className="px-4 pt-4 pb-3">
        <h2 className="font-semibold text-foreground">{count > 1 ? `Your input is needed · ${count} requests` : "Your input is needed"}</h2>
        {!questions.length && <p className="mt-1 leading-relaxed text-muted-foreground">{approval.summary}</p>}
      </div>
      <fieldset disabled={busy} className="min-h-0 space-y-5 overflow-y-auto overscroll-contain px-4 pb-3">
        {questions.map((q, index) => <fieldset key={q.id} className="space-y-2">
          <legend className="mb-2 leading-relaxed font-medium text-foreground">{questions.length > 1 && `${index + 1}. `}{q.title}</legend>
          {q.multiple && <p className="text-xs text-muted-foreground">Select all that apply.</p>}
          {q.options.map((option) => <label key={option.label} className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-[var(--color-background-button-secondary)] px-3 py-2 has-checked:ring-1 has-checked:ring-[var(--color-border-focus)]">
            <input type={q.multiple ? "checkbox" : "radio"} name={`${id}:${q.id}`} checked={(selected[q.id] ?? []).includes(option.label)} className="mt-1 accent-[var(--color-text-foreground)]" onChange={() => {
              setSelected((previous) => ({ ...previous, [q.id]: q.multiple ? (previous[q.id] ?? []).includes(option.label) ? previous[q.id]!.filter((v) => v !== option.label) : [...previous[q.id] ?? [], option.label] : [option.label] }))
              if (!q.multiple) setCustom((previous) => ({ ...previous, [q.id]: "" }))
            }} />
            <span className="min-w-0 leading-relaxed"><span className="font-medium">{option.label}</span>{option.description && <span className="block text-xs text-muted-foreground">{option.description}</span>}</span>
          </label>)}
          {(q.custom || !q.options.length) && <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{q.options.length ? "Write an answer" : "Answer"}</span><input type={q.secret ? "password" : "text"} autoComplete="off" className={FIELD} value={custom[q.id] ?? ""} onChange={(event) => {
            setCustom((previous) => ({ ...previous, [q.id]: event.target.value }))
            if (!q.multiple) setSelected((previous) => ({ ...previous, [q.id]: [] }))
          }} /></label>}
        </fieldset>)}
        {approval.tool_name === "ui_select" && <label className="block space-y-2"><span>Choose an option</span><select className={FIELD} required value={value} onChange={(event) => setValue(event.target.value)}><option value="" disabled>Select…</option>{array(input.options).map((option) => <option key={String(option)}>{String(option)}</option>)}</select></label>}
        {approval.tool_name === "ui_confirm" && <p className="leading-relaxed">{string(input.message)}</p>}
        {(approval.tool_name === "ui_input" || approval.tool_name === "ui_editor") && <label className="block space-y-2"><span>Answer</span>{approval.tool_name === "ui_editor" ? <textarea className={FIELD} rows={6} value={value} onChange={(event) => setValue(event.target.value)} /> : <input className={FIELD} placeholder={string(input.placeholder)} value={value} onChange={(event) => setValue(event.target.value)} />}</label>}
        {elicitation && !isUrl && Object.entries(properties).map(([key, spec]) => <SchemaField key={key} name={key} schema={record(spec)} required={required.includes(key)} />)}
        {isUrl && <div className="space-y-3"><p className="break-all text-xs text-muted-foreground">{url}</p><Button type="button" variant="chrome-outline" size="sm" disabled={!/^https?:\/\//i.test(url)} onClick={() => void openExternal(url).then(() => setUrlOpened(true)).catch((e) => setError(errorText(e)))}>Open in browser</Button><p className="text-xs text-muted-foreground">Complete the request in your browser, then continue.</p></div>}
      </fieldset>
      {error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
      <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void submit()}>Decline</Button>
        {approval.tool_name === "ui_confirm" ? <><Button type="button" variant="chrome-outline" size="sm" disabled={busy} onClick={() => void submit({ confirmed: false })}>Do not confirm</Button><Button type="button" size="sm" disabled={busy} onClick={() => void submit({ confirmed: true })}>Confirm</Button></> : <Button type="submit" size="sm" disabled={busy || (isUrl && !urlOpened)}>{busy ? "Sending…" : "Submit answer"}</Button>}
      </div>
    </form>
  </ComposerStackedPanel>
}

function SchemaField({ name, schema, required }: { name: string; schema: Record<string, unknown>; required: boolean }) {
  const values = array(schema.enum)
  const choices = array(schema.oneOf)
  const options = values.length ? values.map((value, i) => ({ value: String(value), title: String(array(schema.enumNames)[i] ?? value) })) : choices.map((value) => ({ value: String(record(value).const), title: string(record(value).title) || String(record(value).const) }))
  const type = string(schema.type)
  const inputName = `field:${name}`
  const defaultValue = schema.default == null ? undefined : typeof schema.default === "object" ? JSON.stringify(schema.default, null, 2) : String(schema.default)
  return <label className="block space-y-1.5"><span className="font-medium">{string(schema.title) || name}{required ? " *" : " (optional)"}</span>{!!schema.description && <span className="block text-xs leading-relaxed text-muted-foreground">{string(schema.description)}</span>}
    {options.length || type === "boolean" ? <select name={inputName} required={required} defaultValue={defaultValue ?? ""} className={FIELD}><option value="">Select…</option>{(type === "boolean" ? [{ value: "true", title: "Yes" }, { value: "false", title: "No" }] : options).map((o) => <option key={o.value} value={o.value}>{o.title}</option>)}</select>
      : type === "array" && array(record(schema.items).enum).length ? <select multiple name={inputName} required={required} className={FIELD} defaultValue={array(schema.default).map(String)}>{array(record(schema.items).enum).map((item) => <option key={String(item)}>{String(item)}</option>)}</select>
      : type === "array" || type === "object" ? <><span className="block text-xs text-muted-foreground">Enter a JSON {type}.</span><textarea name={inputName} required={required} rows={4} defaultValue={defaultValue} className={FIELD} /></>
      : <input name={inputName} required={required} defaultValue={defaultValue} className={FIELD} type={type === "integer" || type === "number" ? "number" : schema.format === "email" ? "email" : schema.format === "uri" ? "url" : schema.format === "date" ? "date" : "text"} step={type === "integer" ? 1 : "any"} min={typeof schema.minimum === "number" ? schema.minimum : undefined} max={typeof schema.maximum === "number" ? schema.maximum : undefined} minLength={typeof schema.minLength === "number" ? schema.minLength : undefined} maxLength={typeof schema.maxLength === "number" ? schema.maxLength : undefined} pattern={typeof schema.pattern === "string" ? schema.pattern : undefined} />}
  </label>
}
