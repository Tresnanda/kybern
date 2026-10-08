import { Markdown } from "@/components/kybern/Markdown"
import { cn } from "@/lib/utils"
import type { PrDetailResult, PrPageResult } from "@/protocol"

import { PrHeader } from "./PrHeader"
import { PrInfo } from "./PrInfo"
import { PR_BODY_TEXT, PR_QUIET_INK } from "./prText"

export function PrSummaryTab({
  detail,
  projectName,
  number,
  dock,
  pagedChecks,
  checksKind,
  loading,
  onLoadChecks,
  onChecksPage,
  onOpenTimeline,
  linkedTitle,
  onOpenConversation,
}: {
  detail: PrDetailResult
  projectName?: string
  number: number
  dock: boolean
  pagedChecks: PrPageResult | null
  checksKind: boolean
  loading: boolean
  onLoadChecks: () => void
  onChecksPage: (page: number) => void
  onOpenTimeline: () => void
  linkedTitle?: string
  onOpenConversation?: () => void
}) {
  return (
    <div className="pr-summary">
      <PrHeader detail={detail} projectName={projectName} number={number} dock={dock} />
      <section
        className={cn("pr-summary-body mt-6 max-w-[72ch] min-w-0 leading-relaxed break-words", PR_BODY_TEXT)}
        aria-label="Pull request description"
      >
        {detail.body ? (
          <Markdown text={detail.body} />
        ) : (
          <p className={PR_QUIET_INK}>No description provided.</p>
        )}
      </section>
      <PrInfo
        detail={detail}
        pagedChecks={pagedChecks}
        checksKind={checksKind}
        loading={loading}
        onLoadChecks={onLoadChecks}
        onChecksPage={onChecksPage}
        onOpenTimeline={onOpenTimeline}
        linkedTitle={linkedTitle}
        onOpenConversation={onOpenConversation}
      />
    </div>
  )
}
