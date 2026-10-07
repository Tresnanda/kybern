import { Button } from "@/components/kit/button"
import type { PrDetailResult } from "@/protocol"
import { cn } from "@/lib/utils"

export function ReviewTabs<T extends string>({
  value,
  choices,
  onChange,
  label,
  id,
}: {
  value: T
  choices: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  label: string
  id: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="pr-review-tabs"
      onKeyDown={(event) => {
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[role="tab"]'
          )
        )
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        if (
          index < 0 ||
          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
        )
          return
        event.preventDefault()
        const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
        const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : rtl ? 1 : -1
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index + step + buttons.length) % buttons.length
        buttons[next]?.focus()
        buttons[next]?.click()
      }}
    >
      {choices.map(([kind, title]) => (
        <Button
          key={kind}
          id={`${id}-${kind}`}
          role="tab"
          aria-selected={value === kind}
          aria-controls={`${id}-panel`}
          tabIndex={value === kind ? 0 : -1}
          variant="ghost"
          size="sm"
          className={cn(
            "pr-review-tab",
            value === kind && "pr-review-tab-selected"
          )}
          onClick={() => onChange(kind)}
        >
          {title}
        </Button>
      ))}
    </div>
  )
}

export function ReviewMetadata({
  detail,
  projectName,
  linkedTitle,
}: {
  detail: PrDetailResult
  projectName?: string
  linkedTitle?: string
}) {
  return (
    <section className="pr-review-metadata" aria-label="Pull request details">
      <h3 className="text-xs font-medium">Details</h3>
      <dl className="pr-review-metadata-rows">
        <div>
          <dt>Project</dt>
          <dd>{projectName ?? "Project"}</dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{detail.pull_request.author}</dd>
        </div>
        <div>
          <dt>Branches</dt>
          <dd className="font-mono">
            <bdi>{detail.pull_request.head}</bdi> →{" "}
            <bdi>{detail.pull_request.base}</bdi>
          </dd>
        </div>
        <div>
          <dt>Reviewers</dt>
          <dd>{detail.reviewers.join(", ") || "None requested"}</dd>
        </div>
        <div>
          <dt>Changes</dt>
          <dd className="tabular-nums">{detail.changed_files} files</dd>
        </div>
        <div>
          <dt>Reviewed commit</dt>
          <dd className="font-mono" title={detail.head_sha}>
            {detail.head_sha.slice(0, 8)}
          </dd>
        </div>
        <div>
          <dt>Conversation</dt>
          <dd>{linkedTitle ?? "Create one when sending findings"}</dd>
        </div>
      </dl>
    </section>
  )
}
