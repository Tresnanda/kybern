// The subagent page: it is the ordinary thread view over a read-only child thread. These
// are the three places it differs: the breadcrumb in the header, the divider and end row in
// the transcript, and the read-only bar that stands in for the composer.

import { Fragment, forwardRef, useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react"
import { toast } from "sonner"

import {
  formatTokenCount,
  isSubagentQueued,
  spokenElapsed,
  subagentBarState,
  subagentSpan,
  subagentThreadPhase,
  subagentTokenCount,
  subagentTypeLabel,
} from "../../../../../packages/kybern-client/src/subagents.ts"
import { ProviderMark } from "@/components/kybern/bits"
import { ElapsedText } from "@/components/kybern/ElapsedText"
import { IconSwap, MatrixLoader } from "@/components/kybern/motion"
import { Button } from "@/components/kit/button"
import { Menu, MenuGroup, MenuItem, MenuTrigger } from "@/components/kit/menu"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import { COMPOSER_INPUT_SHELL_CLASS_NAME, COMPOSER_INPUT_SURFACE_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { ComposerColumnFrame } from "@/components/kit/chat/ComposerColumnFrame"
import { Kbd } from "@/components/kit/kbd"
import { clockTime, mod } from "@/lib/format"
import { copyText } from "@/lib/hooks"
import { BackToParentIcon, BackgroundTrayIcon, CheckIcon, ChevronRightIcon, CircleAlertIcon, StopIcon } from "@/lib/kit/icons"
import { lastInputWasPointer } from "@/lib/navMotion"
import { cn } from "@/lib/utils"
import type { Thread } from "@/protocol"
import { useStore } from "@/state/store"
import { openParentOf, openThreadView, runSubagentInBackground, stopOneSubagent, useSubagentModel } from "@/state/subagents"
import { ChatHeaderButton } from "../chrome"

const parentTitle = (thread: Thread | undefined) => thread?.title || "Untitled"

// ---- header ----

/** Ancestors as crumbs, then the current subagent's title and type. Back is history; the crumbs are hierarchy. */
export function SubagentBreadcrumb({ thread, ancestors }: { thread: Thread; ancestors: Thread[] }) {
  const heading = useRef<HTMLHeadingElement>(null)
  // Arriving with the pointer moves focus to the title so a screen reader names the page.
  useEffect(() => {
    if (lastInputWasPointer()) heading.current?.focus({ preventScroll: true })
  }, [thread.id])
  const type = subagentTypeLabel(thread.subagent?.agent_type)
  const collapsed = ancestors.length >= 3
  const root = ancestors[0]
  const middle = collapsed ? ancestors.slice(1, -1) : []
  const visible = collapsed ? [root!, ancestors.at(-1)!] : ancestors

  const crumb = (ancestor: Thread, withMark: boolean) => (
    <ChatHeaderButton
      key={ancestor.id}
      type="button"
      tone="plain"
      title={parentTitle(ancestor)}
      className="max-w-44 gap-1.5 px-1.5 text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]"
      onClick={() => openThreadView(ancestor.id)}
    >
      {withMark && <ProviderMark kind={ancestor.provider.kind} tone="header" size={12} className="size-3 shrink-0" />}
      <span className="truncate">{parentTitle(ancestor)}</span>
    </ChatHeaderButton>
  )
  const separator = (key: string) => <ChevronRightIcon key={key} aria-hidden className="size-3 shrink-0 text-foreground/32" />

  return (
    <nav aria-label="Subagent location" className="flex min-w-0 items-center gap-0.5">
      {visible.flatMap((ancestor, index) => {
        const items = [crumb(ancestor, index === 0), separator(`sep:${ancestor.id}`)]
        if (collapsed && index === 0) {
          items.push(
            <Menu key="more">
              <MenuTrigger render={<ChatHeaderButton type="button" tone="plain" aria-label="Show hidden parents" className="px-1.5 text-[var(--color-text-foreground-secondary)]" />}>…</MenuTrigger>
              <ComposerPickerMenuPopup align="start" side="bottom" className="w-56 min-w-56">
                <MenuGroup>
                  {middle.map((ancestorThread) => (
                    <MenuItem key={ancestorThread.id} onClick={() => openThreadView(ancestorThread.id)}>
                      <ProviderMark kind={ancestorThread.provider.kind} size={14} className="size-3.5 shrink-0" />
                      <span className="truncate">{parentTitle(ancestorThread)}</span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>,
            separator("sep:more"),
          )
        }
        return items
      })}
      <div className="flex min-w-0 items-center gap-2 px-1">
        <h2
          ref={heading}
          tabIndex={-1}
          data-tauri-drag-region="false"
          title={thread.title || "Subagent"}
          className="max-w-[22rem] truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-foreground outline-hidden"
        >
          {thread.title || "Subagent"}
        </h2>
        {type && <span className="sa-secondary shrink-0 text-[11px] text-foreground/48">{type}</span>}
      </div>
    </nav>
  )
}

// ---- transcript bookends ----

function useParent(thread: Thread): Thread | undefined {
  return useStore((state) => (thread.parent_thread_id ? state.threads[thread.parent_thread_id] : undefined))
}

/** First row of a subagent transcript: where this conversation comes from. */
export function SubagentDivider({ thread, className }: { thread: Thread; className?: string }) {
  const parent = useParent(thread)
  const startedAt = thread.subagent?.started_at
  return (
    <div className={cn("flex items-center gap-3 pt-2 pb-[18px]", className)} data-subagent-divider="">
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border/55" />
      <span className="sa-secondary inline-flex min-w-0 shrink-0 items-center gap-1.5 font-system-ui text-[11px] font-medium text-foreground/50">
        <ProviderMark kind={thread.provider.kind} size={11} className="size-[11px] shrink-0" />
        <span>Subagent of</span>
        {parent ? (
          <button
            type="button"
            onClick={() => openThreadView(parent.id)}
            className="max-w-[16rem] cursor-pointer truncate text-foreground/72 underline-offset-[3px] outline-hidden hover:text-foreground hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {parentTitle(parent)}
          </button>
        ) : (
          <span className="text-foreground/72">its parent</span>
        )}
        {startedAt && (
          <>
            <span aria-hidden>·</span>
            <time dateTime={startedAt} className="tabular-nums">{clockTime(startedAt)}</time>
          </>
        )}
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border/55" />
    </div>
  )
}

/** Last row once the subagent settled: what it handed back, and to whom. */
export function SubagentEndRow({ thread }: { thread: Thread }) {
  const parent = useParent(thread)
  const phase = subagentThreadPhase(thread)
  if (phase === "working") return null
  const name = parentTitle(parent)
  return (
    <div className="flex items-center gap-3 pt-[22px] pb-2" data-subagent-end="">
      <span aria-hidden className="h-px flex-1 bg-border/55" />
      <span className={cn("sa-secondary inline-flex min-w-0 items-center gap-1.5 font-system-ui text-[11px] font-medium", phase === "failed" ? "text-destructive" : "text-foreground/50")}>
        {phase === "done" && <CheckIcon aria-hidden className="size-3 shrink-0" />}
        {phase === "failed" && <CircleAlertIcon aria-hidden className="size-3 shrink-0" />}
        {phase === "stopped" && <StopIcon aria-hidden className="size-2.5 shrink-0" />}
        <span className="truncate">{phase === "done" ? `Result returned to ${name}` : phase === "failed" ? `Failure reported to ${name}` : "Stopped"}</span>
      </span>
      <span aria-hidden className="h-px flex-1 bg-border/55" />
    </div>
  )
}

// ---- read-only bar ----

/** Takes the composer's place. There is no input: sending to a subagent is not offered (yet). */
export function SubagentBar({ thread, embedded = false }: { thread: Thread; embedded?: boolean }) {
  const Frame = embedded ? Fragment : ComposerColumnFrame
  const info = thread.subagent!
  const { model, effort } = useSubagentModel(thread)
  const phase = subagentThreadPhase(thread)
  const working = phase === "working"
  const queued = isSubagentQueued(thread)
  const span = subagentSpan(thread)
  const settledElapsed = span && span.endedAt !== null ? span.endedAt - span.startedAt : null
  const state = subagentBarState(thread, settledElapsed)
  const tokens = formatTokenCount(subagentTokenCount(thread))
  const canBackground = working && info.capabilities?.background === true && !info.backgrounded
  const canStop = working && info.capabilities?.stop !== false
  const failureText = info.result ?? info.detail ?? null

  // When Stop or Run in background vanish under focus, focus moves to Open parent, never to the body.
  const actions = useRef<HTMLDivElement>(null)
  const openParent = useRef<HTMLButtonElement>(null)
  const focusWasInActions = useRef(false)
  // A removed button does not reliably announce a blur, so focus is tracked on the way in and
  // cleared when the pointer moves it elsewhere.
  useEffect(() => {
    const clear = (event: PointerEvent) => {
      if (!actions.current?.contains(event.target as Node)) focusWasInActions.current = false
    }
    window.addEventListener("pointerdown", clear, true)
    return () => window.removeEventListener("pointerdown", clear, true)
  }, [])
  useLayoutEffect(() => {
    if (working || !focusWasInActions.current) return
    focusWasInActions.current = false
    if (!document.activeElement || document.activeElement === document.body) openParent.current?.focus()
  }, [working])

  // One polite announcement per state change; no per-second chatter.
  const [announcement, setAnnouncement] = useState("")
  const previous = useRef(phase)
  useEffect(() => {
    if (previous.current === phase) return
    previous.current = phase
    const title = thread.title || "Subagent"
    const spoken = settledElapsed !== null ? spokenElapsed(settledElapsed) : null
    setAnnouncement(
      phase === "done" ? `${title} finished${spoken ? ` in ${spoken}` : ""}` : phase === "failed" ? `${title} failed` : phase === "stopped" ? `${title} stopped` : `${title} is working`,
    )
  }, [phase, thread.title, settledElapsed])

  const label = (text: string) => <span className="@max-[600px]:sr-only">{text}</span>
  return (
    <Frame>
      <div className={cn(!embedded && COMPOSER_INPUT_SHELL_CLASS_NAME, "min-w-0")} data-subagent-bar="">
        <div
          className={cn(
            !embedded && COMPOSER_INPUT_SURFACE_CLASS_NAME,
            "@container flex min-h-12 min-w-0 items-center gap-2.5 py-[7px] pr-[7px] pl-4 text-[13px]",
          )}
        >
          <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-foreground/88">
            <IconSwap
              className="size-3.5"
              active={working ? "a" : "b"}
              a={<MatrixLoader variant={queued ? "twinkle" : "orbit"} cycle={1600} className={queued ? "text-muted-foreground/40" : "text-foreground/70"} />}
              b={
                phase === "failed" ? <CircleAlertIcon className="size-3.5 text-destructive" /> : phase === "stopped" ? <StopIcon className="size-2.5 text-muted-foreground/60" /> : <CheckIcon className="size-3.5 text-muted-foreground/70" />
              }
            />
            {working && !queued && span ? (
              <span>
                Working <ElapsedText startedAt={span.startedAt} className="text-foreground/88" />
              </span>
            ) : (
              <span>{state.label}</span>
            )}
          </span>
          <span aria-hidden className="h-4 w-px shrink-0 bg-[var(--color-border-heavy)]" />
          <span className="flex min-w-0 items-center gap-2.5 overflow-hidden text-xs">
            <span className="inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap text-foreground/85">
              <ProviderMark kind={thread.provider.kind} size={12} className="size-3" />
              {model && <span>{model}</span>}
              {effort && <span className="sa-secondary text-[var(--color-text-foreground-secondary)]">{effort}</span>}
            </span>
            {tokens && <span className="sa-secondary truncate tabular-nums text-[var(--color-text-foreground-secondary)]">{tokens}</span>}
          </span>
          <span className="min-w-1 flex-1" />
          <div
            ref={actions}
            className="flex shrink-0 items-center gap-0.5"
            onFocusCapture={() => { focusWasInActions.current = true }}
            onBlurCapture={(event) => { if (event.relatedTarget) focusWasInActions.current = false }}
          >
            {working ? (
              <>
                <BarButton ref={openParent} ghost title="Open parent" onClick={() => openParentOf(thread)}>
                  <BackToParentIcon className="size-3.5" />
                  {label("Open parent")}
                </BarButton>
                {canBackground && (
                  <BarButton ghost animate title="Run in background" onClick={() => void runSubagentInBackground(thread)}>
                    <BackgroundTrayIcon className="size-3.5" />
                    {label("Run in background")}
                  </BarButton>
                )}
                {canStop && (
                  <BarButton outline animate title="Stop" onClick={() => void stopOneSubagent(thread)}>
                    <StopIcon className="size-3" />
                    <span>Stop</span>
                  </BarButton>
                )}
              </>
            ) : (
              <>
                {phase === "failed" && failureText && (
                  <BarButton ghost title="Copy error" onClick={() => void copyText(failureText).then(() => toast("Copied the error"))}>
                    {label("Copy error")}
                  </BarButton>
                )}
                <BarButton ref={openParent} outline title={`Open parent (${mod}↑)`} onClick={() => openParentOf(thread)}>
                  <BackToParentIcon className="size-3.5" />
                  {label("Open parent")}
                  <Kbd className="bg-transparent px-0 text-[11px] font-normal text-foreground/40 @max-[600px]:hidden">{mod}↑</Kbd>
                </BarButton>
              </>
            )}
          </div>
          <span role="status" className="sr-only">{announcement}</span>
        </div>
      </div>
    </Frame>
  )
}

const BarButton = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { ghost?: boolean; outline?: boolean; animate?: boolean }>(function BarButton(
  { ghost, outline, animate, className, ...props },
  ref,
) {
  return (
    <Button
      {...(props as ComponentProps<typeof Button>)}
      ref={ref}
      type="button"
      variant={outline ? "outline" : "ghost"}
      size="sm"
      aria-label={typeof props.title === "string" ? props.title.replace(/ \(.*\)$/, "") : undefined}
      className={cn("!h-8 gap-1.5 rounded-[10px] px-[9px] text-[13px] font-medium", ghost && "text-[var(--color-text-foreground-secondary)]", animate && "sa-bar-action", className)}
    />
  )
})
