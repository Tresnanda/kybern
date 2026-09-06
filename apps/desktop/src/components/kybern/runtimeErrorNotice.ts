import { buttonVariants } from "@/components/kit/button"
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"

// Deliberately independent of the React root: startup/render failures must
// remain readable even if the main tree cannot mount. Only one notice exists.
let notice: HTMLElement | null = null
let technical: HTMLPreElement | null = null
let copyButton: HTMLButtonElement | null = null
let dismissTimer: ReturnType<typeof setTimeout> | undefined
let enterFrame: number | undefined

export function showRuntimeError(details: string) {
  if (notice && technical) {
    clearTimeout(dismissTimer)
    technical.textContent = details
    if (copyButton) copyButton.textContent = "Copy details"
    notice.classList.add("is-open")
    return
  }

  const panel = document.createElement("section")
  panel.className = `runtime-error-notice t-toast ${APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME}`
  panel.setAttribute("aria-label", "Interface error")
  const heading = document.createElement("h2")
  heading.className = "runtime-error-notice__title"
  heading.textContent = "An interface error occurred"
  heading.setAttribute("role", "alert")
  const description = document.createElement("p")
  description.className = "runtime-error-notice__description"
  description.textContent = "Try the action again. If it keeps happening, copy the details to report it."
  const disclosure = document.createElement("details")
  disclosure.className = "runtime-error-notice__details"
  const summary = document.createElement("summary")
  summary.textContent = "Technical details"
  const pre = document.createElement("pre")
  pre.className = "selectable"
  pre.textContent = details
  disclosure.append(summary, pre)
  const actions = document.createElement("div")
  actions.className = "runtime-error-notice__actions"
  const copy = document.createElement("button")
  copy.type = "button"
  copy.className = buttonVariants({ variant: "secondary", size: "sm" })
  copy.textContent = "Copy details"
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent ?? "")
      copy.textContent = "Copied"
    } catch {
      disclosure.open = true
      copy.textContent = "Select details to copy"
    }
  }
  const dismiss = document.createElement("button")
  dismiss.type = "button"
  dismiss.className = buttonVariants({ variant: "ghost", size: "sm" })
  dismiss.textContent = "Dismiss"
  dismiss.onclick = () => {
    if (enterFrame !== undefined) cancelAnimationFrame(enterFrame)
    panel.classList.remove("is-open")
    const duration = getComputedStyle(panel).getPropertyValue("--toast-close").trim()
    const ms = duration.endsWith("ms") ? parseFloat(duration) : parseFloat(duration) * 1000
    dismissTimer = setTimeout(() => {
      panel.remove()
      if (notice === panel) { notice = null; technical = null; copyButton = null }
    }, Number.isFinite(ms) ? ms : 250)
  }
  actions.append(copy, dismiss)
  panel.append(heading, description, disclosure, actions)
  notice = panel
  technical = pre
  copyButton = copy
  document.body.appendChild(panel)
  // Establish the closed presentation before the transition starts.
  panel.getBoundingClientRect()
  enterFrame = requestAnimationFrame(() => panel.classList.add("is-open"))
}
