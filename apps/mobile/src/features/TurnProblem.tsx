// A failed turn the daemon could name (signed out, a usage limit, no connection, ...), in the words `describeTurnFailure` writes for a phone:
// what happened, and what to do on the computer that ran it, drawn by the shared Problem component (`ui/Problem.tsx`). A phone runs no
// fix, so there are no buttons; the agent's own text sits behind Show details.
import { useMemo, type ReactNode } from "react";
import { describeTurnFailure } from "../../../../packages/kybern-client/src/problems";
import type { Problem } from "../../../../packages/kybern-client/src/types";
import { problemLook, type ProblemModel } from "../state/problems";
import { activeEnvironment, useThreadValue } from "../state/runtime";
import type { ThreadState } from "../state/transcript";
import { ErrorBanner } from "../ui/Problem";

const providerOf = (snapshot: ThreadState) => snapshot.thread?.provider;

/** The failed turn as a Problem banner, or `fallback` (the agent's text sorted by its words) when the daemon did not name the cause. */
export function TurnProblemLine({ threadId, error, problem, fallback }: { threadId: string; error: string; problem?: Problem; fallback: ReactNode }) {
  const provider = useThreadValue(threadId, providerOf);
  const model = useMemo<ProblemModel | null>(() => {
    if (!problem || !provider) return null;
    const view = describeTurnFailure({ error, problem }, { provider: provider.kind, instance: provider.instance, machine: activeEnvironment()?.name, phone: true });
    if (!view) return null;
    const { tone, icon } = problemLook(view.kind);
    return { kind: view.kind, subject: view.subject, tone, icon, title: view.title, body: view.body, actions: [], detail: view.detail };
  }, [error, problem, provider]);
  return model ? <ErrorBanner error={model} /> : <>{fallback}</>;
}
