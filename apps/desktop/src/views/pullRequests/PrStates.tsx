import { Alert } from "@/components/kit/alert"
import { Button } from "@/components/kit/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/kit/empty"
import { Skeleton } from "@/components/kit/skeleton"
import { copyText } from "@/lib/hooks"
import { openExternal } from "@/lib/tauri"
import type { PrErrorClass } from "@/state/prReviewModel"

/** The GitHub CLI is missing or signed out: the copy and the recovery action for each. */
export function GhProblem({
  kind,
  onRefresh,
}: {
  kind: Extract<PrErrorClass, "gh-missing" | "gh-auth">
  onRefresh: () => void
}) {
  const missing = kind === "gh-missing"
  return (
    <Empty className="py-12" data-gh-problem={kind}>
      <EmptyHeader>
        <EmptyTitle className="text-base">
          {missing ? "Install the GitHub CLI" : "Sign in to the GitHub CLI"}
        </EmptyTitle>
        <EmptyDescription>
          {missing ? (
            <>
              Kybern reads pull requests through <code>gh</code> on this Mac.
              Install it, sign in with <code>gh auth login</code>, then refresh.
            </>
          ) : (
            <>
              Run <code>gh auth login</code> in a terminal, then refresh.
            </>
          )}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center gap-2">
        {missing ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openExternal("https://cli.github.com")}
          >
            Open install guide
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void copyText("gh auth login")}
          >
            Copy command
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </EmptyContent>
    </Empty>
  )
}

export function PrErrorAlert({
  children,
  onRetry,
}: {
  children: React.ReactNode
  onRetry: () => void
}) {
  return (
    <Alert variant="error" size="sm" className="items-center">
      <div className="min-w-0 break-words">{children}</div>
      <Button size="xs" variant="ghost" onClick={onRetry}>
        Try again
      </Button>
    </Alert>
  )
}

export function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading pull requests" className="flex flex-col">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 px-3 py-2.5">
          <Skeleton className="h-3.5 w-[78%]" />
          {i % 2 === 0 && <Skeleton className="h-3.5 w-[52%]" />}
          <Skeleton className="h-3 w-[40%]" />
        </div>
      ))}
    </div>
  )
}

export function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading pull request"
      className="mx-auto flex w-full max-w-[76rem] flex-col gap-4 px-6 pt-4 pb-16"
    >
      <Skeleton className="h-6 w-16 rounded-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-[70%]" />
        <Skeleton className="h-6 w-[45%]" />
      </div>
      <Skeleton className="h-4 w-1/2" />
      <div className="mt-4 flex flex-col gap-3">
        {[92, 85, 96, 60].map((w) => (
          <Skeleton key={w} className="h-3.5" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="mt-6 flex flex-col gap-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3.5 w-[60%]" />
            <Skeleton className="h-3.5 w-[40%]" />
          </div>
        ))}
      </div>
    </div>
  )
}
