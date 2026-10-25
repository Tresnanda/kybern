// Pull requests on the phone (parity P1-2): one pull request's detail, its paged comments and
// checks, and the review draft. The draft rules (head binding, repair prompt) are the shared
// ones in `packages/kybern-client/src/prReview.ts`; drafts live for the app session, keyed by
// computer, project and number, so leaving the screen never loses a half-written review.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  afterReviewSubmission,
  assertReviewDraftHead,
  bindReviewDraft,
  emptyReviewDraft,
  repairReviewPrompt,
  toggleReviewFinding,
  type ReviewDraft,
} from "../../../../packages/kybern-client/src/prReview";
import { linkedRepairThread } from "../../../../packages/kybern-client/src/pullRequests";
import type { PrActionKind, PrDetailResult, PrPageKind, PrPageResult, PrReviewEntry } from "./protocol";
import { activeEnvironment, errorText, refresh, rpc, useApp } from "./runtime";

const drafts = new Map<string, ReviewDraft>();
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
/** `repo`: the member repository of a group project the pull request is in (a `PullRequest.repo`). */
const draftKey = (projectId: string, number: number, repo?: string) =>
  `${activeEnvironment()?.id ?? ""}:${projectId}${repo ? `/${repo}` : ""}:${number}`;
const NO_MEMBER_CHECKOUT = "A pull request of a group project can't be checked out into a conversation yet. Open that repository as its own project.";
function saveDraft(key: string, draft: ReviewDraft) {
  drafts.set(key, draft);
  if (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
  listeners.forEach((fn) => fn());
}
const EMPTY = emptyReviewDraft();

export function usePullRequest(projectId: string, number: number, repo?: string) {
  const app = useApp();
  const key = draftKey(projectId, number, repo);
  const member = repo ? { repo } : {};
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key) ?? EMPTY);
  const [detail, setDetail] = useState<PrDetailResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<PrActionKind | "repair" | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (app.status !== "open" || !projectId || !number) return;
    let canceled = false;
    setLoading(true);
    void rpc("github.pr.detail", { project_id: projectId, number, ...member })
      .then((next) => {
        if (canceled) return;
        setDetail(next);
        setError("");
      })
      .catch((e) => {
        if (!canceled) setError(errorText(e));
      })
      .finally(() => {
        if (!canceled) setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [projectId, number, repo, revision, app.status, app.activeId]);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  const update = (patch: Partial<ReviewDraft>) =>
    saveDraft(key, bindReviewDraft(drafts.get(key) ?? EMPTY, patch, detail?.head_sha ?? null));
  const toggleFinding = (id: string, entry: PrReviewEntry) => {
    const current = drafts.get(key) ?? EMPTY;
    const next = toggleReviewFinding(current, id, entry);
    if (next === current) throw new Error("Select at most 100 comments for one repair.");
    saveDraft(key, next);
  };
  const linked = linkedRepairThread(app.threads, projectId, detail?.pull_request.head, draft.threadId);

  /** Review, comment, close: throws a message that says what to do next. */
  async function act(action: PrActionKind, threadId?: string) {
    if (!detail) throw new Error("Refresh this pull request, then try again.");
    const submitted = drafts.get(key) ?? EMPTY;
    const review = action === "comment" || action === "approve" || action === "request_changes";
    if (review) assertReviewDraftHead(submitted, detail.head_sha);
    setBusy(action);
    try {
      await rpc("github.pr.action", {
        project_id: projectId,
        number,
        action,
        head_sha: detail.head_sha,
        body: review ? submitted.body : "",
        inline_comments: [],
        ...(threadId ? { thread_id: threadId } : {}),
        ...member,
      });
      if (review) saveDraft(key, afterReviewSubmission(drafts.get(key) ?? EMPTY, submitted));
      if (alive.current) reload();
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  /** A worktree conversation for checkout or repair: the chosen one, or a new one with the computer's defaults. */
  async function conversation(choice: string | "new"): Promise<string> {
    if (choice !== "new") return choice;
    const settings = await rpc("settings.get", {});
    const created = await rpc("threads.create", {
      project_id: projectId,
      provider: { kind: settings.default_provider, instance: "default" },
      permission_mode: settings.default_permission_mode,
      use_worktree: true,
    });
    await refresh();
    return created.id;
  }

  /** Check the pull request out into a worktree conversation. Resolves to that conversation. */
  async function checkout(choice: string | "new") {
    if (!detail) throw new Error("Refresh this pull request, then try again.");
    if (repo) throw new Error(NO_MEMBER_CHECKOUT);
    setBusy("checkout");
    try {
      const target = await conversation(choice);
      await rpc("github.pr.action", {
        project_id: projectId,
        number,
        action: "checkout",
        thread_id: target,
        head_sha: detail.head_sha,
      });
      await refresh();
      return target;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  /** Send the selected comments to an agent that repairs the branch. Resolves to its conversation. */
  async function repair(choice: string | "new") {
    if (!detail) throw new Error("Refresh this pull request, then try again.");
    if (repo) throw new Error(NO_MEMBER_CHECKOUT);
    const current = drafts.get(key) ?? EMPTY;
    assertReviewDraftHead(current, detail.head_sha);
    const prompt = repairReviewPrompt(number, detail.pull_request.title, detail.pull_request.url, detail.head_sha, current);
    setBusy("repair");
    try {
      const reuse = current.threadId && current.threadId !== "new" ? current.threadId : null;
      const target = reuse ?? (await conversation(choice));
      // Keep the identity before checkout, so a retry never creates a second repair conversation.
      saveDraft(key, { ...(drafts.get(key) ?? EMPTY), threadId: target });
      await rpc("github.pr.action", {
        project_id: projectId,
        number,
        action: "checkout",
        thread_id: target,
        head_sha: detail.head_sha,
        for_repair: true,
      });
      await rpc("threads.send", { thread_id: target, message: { parts: [{ type: "text", text: prompt }] } });
      saveDraft(key, { ...(drafts.get(key) ?? EMPTY), selected: [], findings: {} });
      await refresh();
      return target;
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  return { detail, error, loading, revision, reload, draft, update, toggleFinding, linked, busy, act, checkout, repair };
}

/** One page of comments, reviews or checks. Stale replies never replace a newer page. */
export function usePrPage(projectId: string, number: number, kind: PrPageKind, revision: number, head?: string, repo?: string) {
  const status = useApp().status;
  const [state, setState] = useState<{ key: string; data?: PrPageResult; error?: string } | null>(null);
  const key = `${projectId}${repo ? `/${repo}` : ""}:${number}:${kind}:${revision}:${head}`;
  useEffect(() => {
    if (!head || status !== "open") return;
    let canceled = false;
    void rpc("github.pr.page", { project_id: projectId, number, kind, page: 1, ...(repo ? { repo } : {}) }).then(
      (data) => !canceled && setState({ key, data }),
      (e) => !canceled && setState({ key, error: errorText(e) }),
    );
    return () => {
      canceled = true;
    };
  }, [key, status]);
  return { data: state?.key === key ? state.data : undefined, error: state?.key === key ? state.error : undefined };
}

/** The draft for a pull request without loading it (the review and send sheets). */
export function usePrDraft(projectId: string, number: number, repo?: string) {
  const key = draftKey(projectId, number, repo);
  return useSyncExternalStore(subscribe, () => drafts.get(key) ?? EMPTY);
}
