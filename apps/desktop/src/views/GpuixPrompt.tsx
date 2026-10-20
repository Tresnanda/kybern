import { AnimatePresence } from "motion/react"
import { useEffect, useState } from "react"

import { Spinner } from "@/components/kybern/bits"
import { Button } from "@/components/kit/button"
import { APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME } from "@/components/kit/chat/composerPickerStyles"
import { IconButton } from "@/components/kit/icon-button"
import { canSelfUpdate, useAppUpdate } from "@/lib/appUpdate"
import {
  dismissGpuixPrompt,
  gpuixErrorParts,
  gpuixStepLabel,
  installGpuix,
  markGpuixPromptShown,
  useGpuix,
} from "@/lib/gpuix"
import { shouldShowGpuixPrompt } from "@/lib/gpuixPromptRules"
import { CheckIcon, CopyIcon, XIcon } from "@/lib/kit/icons"
import { cn } from "@/lib/utils"
import { ReleaseArtwork } from "@/views/AppUpdate"
import { useToastPresence } from "@/views/useToastPresence"

/** Copy `command` and report it for a moment; the manual install must stay one paste away. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex items-start gap-1.5 rounded-xl bg-foreground/5 py-1.5 ps-3 pe-1.5">
      <code
        data-testid="gpuix-manual-command"
        className="selectable min-w-0 flex-1 py-0.5 font-mono text-[11px] leading-relaxed break-all text-foreground/80"
      >
        {command}
      </code>
      <Button
        size="sm"
        variant="ghost"
        aria-label="Copy install command"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => {})
        }}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

/** The one-time invitation to Kybern GPUIX, in the update announcement's card style. */
export function GpuixPromptCard() {
  const { element, present } = useToastPresence()
  const phase = useGpuix((state) => state.phase)
  const step = useGpuix((state) => state.step)
  const progress = useGpuix((state) => state.progress)
  const error = useGpuix((state) => state.error)
  const installing = phase === "installing"
  const parts = error ? gpuixErrorParts(error) : null

  useEffect(() => {
    markGpuixPromptShown()
  }, [])

  return (
    <aside
      ref={element}
      data-testid="gpuix-prompt"
      aria-label="Kybern GPUIX"
      aria-hidden={!present}
      inert={!present}
      className={cn(
        APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
        "t-toast release-announcement font-system-ui fixed right-4 bottom-4 z-40 flex max-h-[calc(100dvh-2rem)] w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-3xl text-foreground"
      )}
    >
      <ReleaseArtwork compact />
      <IconButton
        label="Dismiss Kybern GPUIX invitation"
        size="icon-sm"
        disabled={installing}
        className="absolute end-5 top-5 !size-8 !rounded-full !bg-black/35 !text-white hover:!bg-black/55"
        onClick={dismissGpuixPrompt}
      >
        <XIcon className="size-4" />
      </IconButton>
      <div className="flex flex-col gap-2 p-5">
        <p className="text-xs font-medium text-muted-foreground">New · Native app</p>
        <h2 className="text-lg leading-snug font-medium text-balance break-words">
          Meet Kybern GPUIX
        </h2>
        <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
          A native app that uses about 60% less memory and less CPU, with
          everything you use today. It runs next to this app and shares your
          projects and chats.
        </p>
        {parts && (
          <div className="mt-1 flex flex-col gap-2">
            <p role="alert" className="text-xs leading-relaxed break-words text-destructive">
              {parts.message}
            </p>
            <CopyCommand command={parts.command} />
          </div>
        )}
        <div role="status" aria-live="polite" className="contents">
          {phase === "done" && (
            <p className="mt-1 text-sm font-medium">Installed. Opening Kybern GPUIX…</p>
          )}
        </div>
        {phase !== "done" && (
          <div className="mt-2 flex items-center gap-2">
            <Button
              disabled={installing}
              onClick={() => void installGpuix()}
              className="tabular-nums"
            >
              {installing && <Spinner />}
              {installing
                ? gpuixStepLabel(step, progress)
                : phase === "error"
                  ? "Try again"
                  : "Install Kybern GPUIX"}
            </Button>
            <Button variant="ghost" disabled={installing} onClick={dismissGpuixPrompt}>
              Not now
            </Button>
          </div>
        )}
      </div>
    </aside>
  )
}

/**
 * Shows the card once, after the first update check, and never on top of the
 * update announcement or its release details. An install under way keeps it open.
 */
export function GpuixPromptSurface() {
  const eligible = useGpuix((state) => state.eligible)
  const dismissed = useGpuix((state) => state.dismissed)
  const phase = useGpuix((state) => state.phase)
  const updateOpen = useAppUpdate((state) => state.announcementOpen || state.detailsOpen)
  const updateSettled = useAppUpdate((state) => state.checkedAt !== null || !canSelfUpdate())
  const visible =
    !dismissed &&
    eligible &&
    (phase !== "idle" ||
      shouldShowGpuixPrompt({ eligible, dismissed, updateSettled, updateOpen }))
  return <AnimatePresence initial={false}>{visible && <GpuixPromptCard key="gpuix-prompt" />}</AnimatePresence>
}
