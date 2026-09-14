/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { createAgentStarter } from "../../../../packages/kybern-client/src/agentStart"
import { shouldReloadCollaboration } from "../../../../packages/kybern-client/src/collaboration"

import { Button } from "@/components/kit/button"
import { ComposerPickerMenuPopup } from "@/components/kit/chat/ComposerPickerMenuPopup"
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "@/components/kit/dialog"
import { Input } from "@/components/kit/input"
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/kit/menu"
import { Textarea } from "@/components/kit/textarea"
import { ProviderMark, Spinner } from "@/components/kybern/bits"
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  MessageCircleIcon,
  PauseOutlineIcon,
  PencilIcon,
  PlayOutlineIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
  StopIcon,
  UsersIcon,
} from "@/lib/kit/icons"
import type {
  AssignmentKind,
  CollaborationAssignment,
  CollaborationGroupDetail,
  CollaborationMessage,
  ContextEntry,
  ContextEntryKind,
  GroupMember,
  GroupMemberRole,
  ProviderKind,
  ProviderStatus,
  ProjectCoordinatorCreateParams,
  Thread,
  ThreadEvent,
  ThreadId,
} from "@/protocol"
import { activeRuntime, errorText, rpc, subscribeCollaboration } from "@/state/rpc"
import { useStore } from "@/state/store"

const DONE = new Set(["completed", "failed", "cancelled"])
const NEEDS_ATTENTION = new Set([
  "blocked",
  "waiting",
  "attention_needed",
  "failed",
])
const sectionTitle =
  "text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground"
const meta =
  "text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-muted-foreground"
type CollaborationView = "work" | "messages" | "context" | "results"
type CollaborationDialog =
  | "objective"
  | "settings"
  | "participants"
  | "assignment"
  | "message"
  | "progress"
  | "context"
  | null
type AgentDraft = {
  provider: ProviderKind
  task: string
  model: string
  title: string
  kind: AssignmentKind
  baseRevision: string
  advanced: boolean
}
const assignmentNeedsAttention = (assignment: CollaborationAssignment) =>
  NEEDS_ATTENTION.has(assignment.status) ||
  assignment.result?.outcome === "partial" ||
  assignment.result?.outcome === "failed"
const dedicatedUnsupported = (kind: ProviderKind) =>
  kind === "codex" || kind === "cursor"

async function releaseCoordinatorForMode(
  coordinator: Thread | undefined,
  current: "ordinary" | "dedicated",
  next: "ordinary" | "dedicated",
  force = false
) {
  if (current === next && !force) return
  if (!coordinator) return
  if (
    coordinator.status === "running" ||
    coordinator.status === "awaiting-approval"
  ) {
    throw new Error(
      "Finish or stop the coordinator's current turn before changing collaboration mode or policy."
    )
  }
  if (coordinator.status === "idle" && coordinator.provider_session_id)
    await rpc().call("threads.release", { thread_id: coordinator.id })
}

export function CollaborationPane({
  threadId,
  active,
}: {
  threadId: ThreadId
  active: boolean
}) {
  const thread = useStore((s) => s.threads[threadId])
  const projectId = thread?.project_id
  const threadMap = useStore((s) => s.threads)
  const allProviders = useStore((s) => s.providers)
  const threads = useMemo(
    () =>
      Object.values(threadMap).filter(
        (item) =>
          item.project_id === thread?.project_id && item.status !== "archived"
      ),
    [threadMap, thread?.project_id]
  )
  const providers = useMemo(
    () => allProviders.filter((item) => item.available),
    [allProviders]
  )
  const selectThread = useStore((s) => s.selectThread)
  const [detail, setDetail] = useState<CollaborationGroupDetail | null>(null)
  const [currentDetail, setCurrentDetail] =
    useState<CollaborationGroupDetail | null>(null)
  const selectedHistoryId = useRef<string | null>(null)
  const [viewingPrevious, setViewingPrevious] = useState(false)
  const [previousGroups, setPreviousGroups] = useState<
    CollaborationGroupDetail[]
  >([])
  const [nextGroups, setNextGroups] = useState<string | null>(null)
  const [messages, setMessages] = useState<CollaborationMessage[]>([])
  const [context, setContext] = useState<ContextEntry[]>([])
  const [assignments, setAssignments] = useState<CollaborationAssignment[]>([])
  const [nextAssignments, setNextAssignments] = useState<string | null>(null)
  const [nextMessages, setNextMessages] = useState<string | null>(null)
  const [nextContext, setNextContext] = useState<string | null>(null)
  const [olderWindow, setOlderWindow] = useState({
    assignments: false,
    messages: false,
    context: false,
  })
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [view, setView] = useState<CollaborationView>("work")
  const [dialog, setDialog] = useState<CollaborationDialog>(null)
  const [agentDraft, setAgentDraft] = useState<AgentDraft>({
    provider: providers[0]?.kind ?? "codex",
    task: "",
    model: "",
    title: "",
    kind: "edit",
    baseRevision: "",
    advanced: false,
  })
  const agentStarter = useRef(
    createAgentStarter(
      (method, params) => rpc().call(method, params),
      () => crypto.randomUUID()
    )
  )
  const coordinatorReviveAttempt = useRef<{
    store: typeof useStore
    runtime: ReturnType<typeof activeRuntime>
    projectId: string
    threadId: ThreadId
    request: ProjectCoordinatorCreateParams
  } | null>(null)
  const loadGeneration = useRef(0)
  const dialogTrigger = useRef<HTMLElement | null>(null)
  const scrollContainer = useRef<HTMLDivElement | null>(null)
  const viewPositions = useRef<Record<CollaborationView, number>>({
    work: 0,
    messages: 0,
    context: 0,
    results: 0,
  })
  const loadedLimits = useRef({ assignments: 50, messages: 50, context: 50 })

  const load = useCallback(
    async (historyId: string | null = selectedHistoryId.current) => {
      if (!projectId) return
      const generation = ++loadGeneration.current
      setLoading(true)
      setError("")
      try {
        let found: CollaborationGroupDetail | null = null
        let newestMatch: CollaborationGroupDetail | null = null
        const matches: CollaborationGroupDetail[] = []
        let cursor: string | undefined
        do {
          const listed = await rpc().call("collaboration.groups.list", {
            project_id: projectId,
            include_stopped: true,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          })
          for (const group of listed.groups) {
            if (generation !== loadGeneration.current) return
            const candidate = await rpc().call("collaboration.groups.get", {
              group_id: group.id,
            })
            if (
              candidate.members.some(
                (member) => member.thread_id === threadId
              ) ||
              group.coordinator_thread_id === threadId
            ) {
              matches.push(candidate)
              newestMatch ??= candidate
              if (group.status === "active") found ??= candidate
            }
          }
          cursor = listed.next_cursor ?? undefined
          if (found || generation !== loadGeneration.current) break
        } while (cursor)
        found ??= newestMatch
        if (generation !== loadGeneration.current) return
        const selected = historyId
          ? await rpc().call("collaboration.groups.get", {
              group_id: historyId,
            })
          : null
        if (generation !== loadGeneration.current) return
        const shown = selected ?? found
        setDetail(shown)
        setCurrentDetail(found)
        setViewingPrevious(Boolean(selected))
        setPreviousGroups(
          [...matches, ...(selected ? [selected] : [])].filter(
            (candidate, index, candidates) =>
              candidate.group.id !== found?.group.id &&
              candidates.findIndex(
                (item) => item.group.id === candidate.group.id
              ) === index
          )
        )
        setNextGroups(cursor ?? null)
        setOlderWindow({ assignments: false, messages: false, context: false })
        if (shown) {
          const [assignmentPage, messagePage, contextPage] = await Promise.all([
            rpc().call("collaboration.assignments.list", {
              group_id: shown.group.id,
              include_finished: true,
              limit: loadedLimits.current.assignments,
            }),
            rpc().call("collaboration.messages.list", {
              group_id: shown.group.id,
              limit: loadedLimits.current.messages,
            }),
            rpc().call("collaboration.context.list", {
              group_id: shown.group.id,
              limit: loadedLimits.current.context,
            }),
          ])
          if (generation !== loadGeneration.current) return
          setAssignments(assignmentPage.assignments)
          setNextAssignments(assignmentPage.next_cursor ?? null)
          setMessages(messagePage.messages)
          setNextMessages(messagePage.next_cursor ?? null)
          setContext(contextPage.entries)
          setNextContext(contextPage.next_cursor ?? null)
        } else {
          setMessages([])
          setContext([])
          setAssignments([])
        }
      } catch (cause) {
        if (generation === loadGeneration.current) setError(errorText(cause))
      } finally {
        if (generation === loadGeneration.current) setLoading(false)
      }
    },
    [projectId, threadId]
  )

  useEffect(() => {
    selectedHistoryId.current = null
    setViewingPrevious(false)
  }, [threadId])

  useEffect(() => {
    if (active) void load()
    const generation = loadGeneration.current
    return () => {
      if (loadGeneration.current === generation) loadGeneration.current++
    }
  }, [active, load])
  useEffect(() => {
    const selectCoordinatorView = (event: Event) => {
      const next = (event as CustomEvent<CollaborationView>).detail
      if (next === "work" || next === "context" || next === "results") switchView(next)
    }
    window.addEventListener("kybern:collaboration-view", selectCoordinatorView)
    return () => window.removeEventListener("kybern:collaboration-view", selectCoordinatorView)
  }, [view])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribeCollaboration((event: ThreadEvent | null) => {
      if (active && shouldReloadCollaboration(event, detail?.group.id)) {
        clearTimeout(timer)
        timer = setTimeout(() => void load(), event === null ? 0 : 80)
      }
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [active, detail?.group.id, load])

  async function run(work: () => Promise<unknown>) {
    setBusy(true)
    setError("")
    try {
      await work()
      await load()
    } catch (cause) {
      setError(errorText(cause))
      toast.error("Unable to update agents", { description: errorText(cause) })
    } finally {
      setBusy(false)
    }
  }

  async function startAgent() {
    const provider = providers.find((item) => item.kind === agentDraft.provider)
    if (!provider) return
    setBusy(true)
    setError("")
    try {
      const started = await agentStarter.current.start({
        thread: thread!,
        group: detail?.group,
        provider,
        task: agentDraft.task,
        ...(agentDraft.model ? { model: agentDraft.model } : {}),
        ...(agentDraft.title ? { title: agentDraft.title } : {}),
        kind: agentDraft.kind,
        ...(agentDraft.baseRevision
          ? { baseRevision: agentDraft.baseRevision }
          : {}),
      })
      toast("Task accepted", { description: started.assignment.title })
      setAgentDraft((current) => ({
        ...current,
        task: "",
        model: "",
        title: "",
        baseRevision: "",
        advanced: false,
      }))
      setDialog(null)
      selectedHistoryId.current = null
      setViewingPrevious(false)
      await load(null)
    } catch (cause) {
      const message = errorText(cause)
      setError(message)
      if (message.includes("detached commit")) {
        setAgentDraft((current) => ({ ...current, advanced: true }))
      }
      toast.error("Unable to start agent", { description: message })
    } finally {
      setBusy(false)
    }
  }

  if (!active) return null
  if (loading && !detail && dialog !== "assignment")
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={16} />
      </div>
    )
  if (!thread) return null
  if (!detail)
    return (
      <>
        <AgentsEmpty error={error} />
      </>
    )

  const group = detail.group
  const activeAssignments = assignments.filter((item) => !DONE.has(item.status))
  const finishedAssignments = assignments.filter((item) =>
    DONE.has(item.status)
  )
  async function loadMore(kind: "assignments" | "messages" | "context") {
    if (kind === "assignments" && nextAssignments) {
      const page = await rpc().call("collaboration.assignments.list", {
        group_id: group.id,
        include_finished: true,
        cursor: nextAssignments,
        limit: 50,
      })
      setAssignments((current) => {
        const combined = [
          ...current,
          ...page.assignments.filter(
            (item) => !current.some((existing) => existing.id === item.id)
          ),
        ]
        if (combined.length > 200)
          setOlderWindow((value) => ({ ...value, assignments: true }))
        return combined.slice(-200)
      })
      loadedLimits.current.assignments = Math.min(
        200,
        loadedLimits.current.assignments + page.assignments.length
      )
      setNextAssignments(page.next_cursor ?? null)
    } else if (kind === "messages" && nextMessages) {
      const page = await rpc().call("collaboration.messages.list", {
        group_id: group.id,
        cursor: nextMessages,
        limit: 50,
      })
      setMessages((current) => {
        const combined = [
          ...current,
          ...page.messages.filter(
            (item) => !current.some((existing) => existing.id === item.id)
          ),
        ]
        if (combined.length > 200)
          setOlderWindow((value) => ({ ...value, messages: true }))
        return combined.slice(-200)
      })
      loadedLimits.current.messages = Math.min(
        200,
        loadedLimits.current.messages + page.messages.length
      )
      setNextMessages(page.next_cursor ?? null)
    } else if (kind === "context" && nextContext) {
      const page = await rpc().call("collaboration.context.list", {
        group_id: group.id,
        cursor: nextContext,
        limit: 50,
      })
      setContext((current) => {
        const combined = [
          ...current,
          ...page.entries.filter(
            (item) => !current.some((existing) => existing.id === item.id)
          ),
        ]
        if (combined.length > 200)
          setOlderWindow((value) => ({ ...value, context: true }))
        return combined.slice(-200)
      })
      loadedLimits.current.context = Math.min(
        200,
        loadedLimits.current.context + page.entries.length
      )
      setNextContext(page.next_cursor ?? null)
    }
  }
  async function more(kind: "assignments" | "messages" | "context") {
    setBusy(true)
    setError("")
    try {
      await loadMore(kind)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  async function showGroup(
    candidate: CollaborationGroupDetail,
    previous: boolean
  ) {
    const generation = ++loadGeneration.current
    selectedHistoryId.current = previous ? candidate.group.id : null
    setBusy(true)
    setError("")
    try {
      const [fresh, assignmentPage, messagePage, contextPage] =
        await Promise.all([
          rpc().call("collaboration.groups.get", {
            group_id: candidate.group.id,
          }),
          rpc().call("collaboration.assignments.list", {
            group_id: candidate.group.id,
            include_finished: true,
            limit: 50,
          }),
          rpc().call("collaboration.messages.list", {
            group_id: candidate.group.id,
            limit: 50,
          }),
          rpc().call("collaboration.context.list", {
            group_id: candidate.group.id,
            limit: 50,
          }),
        ])
      if (generation !== loadGeneration.current) return
      setDetail(fresh)
      if (!previous) setCurrentDetail(fresh)
      setViewingPrevious(previous)
      setAssignments(assignmentPage.assignments)
      setNextAssignments(assignmentPage.next_cursor ?? null)
      setMessages(messagePage.messages)
      setNextMessages(messagePage.next_cursor ?? null)
      setContext(contextPage.entries)
      setNextContext(contextPage.next_cursor ?? null)
      setOlderWindow({ assignments: false, messages: false, context: false })
    } catch (cause) {
      if (generation === loadGeneration.current) setError(errorText(cause))
    } finally {
      if (generation === loadGeneration.current) setBusy(false)
    }
  }
  async function loadEarlierGroups() {
    if (!nextGroups || !projectId) return
    setBusy(true)
    setError("")
    try {
      const listed = await rpc().call("collaboration.groups.list", {
        project_id: projectId,
        include_stopped: true,
        limit: 100,
        cursor: nextGroups,
      })
      const candidates = await Promise.all(
        listed.groups.map((group) =>
          rpc().call("collaboration.groups.get", { group_id: group.id })
        )
      )
      const matching = candidates.filter(
        (candidate) =>
          candidate.members.some((member) => member.thread_id === threadId) ||
          candidate.group.coordinator_thread_id === threadId
      )
      setPreviousGroups((current) => [
        ...current,
        ...matching.filter(
          (candidate) =>
            !current.some((saved) => saved.group.id === candidate.group.id)
        ),
      ])
      setNextGroups(listed.next_cursor ?? null)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  function openDialog(next: Exclude<CollaborationDialog, null>) {
    dialogTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    setDialog(next)
  }
  function changeDialog(
    next: Exclude<CollaborationDialog, null>,
    open: boolean
  ) {
    if (open) {
      setDialog(next)
      return
    }
    setDialog(null)
    const trigger = dialogTrigger.current
    requestAnimationFrame(() =>
      (trigger?.isConnected
        ? trigger
        : document.querySelector<HTMLElement>(
            "[aria-label='More agent actions']"
          )
      )?.focus()
    )
  }
  function switchView(next: CollaborationView) {
    if (next === view) return
    const container = scrollContainer.current
    if (container) viewPositions.current[view] = container.scrollTop
    setView(next)
    requestAnimationFrame(() => {
      if (container) container.scrollTop = viewPositions.current[next]
    })
  }
  function messageThread(target: ThreadId) {
    selectThread(target)
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>("[data-testid='composer-editor']")
        ?.focus()
    )
  }
  const attentionAssignments = activeAssignments.filter(
    assignmentNeedsAttention
  )
  const quietAssignments = activeAssignments.filter(
    (item) => !assignmentNeedsAttention(item)
  )
  const coordinator = threadMap[group.coordinator_thread_id]
  const persistentCoordinator =
    coordinator?.coordinator_project_id === group.project_id
  const collaborationViews: CollaborationView[] = persistentCoordinator
    ? ["work", "context", "results"]
    : ["work", "messages", "context"]
  async function revivePersistentCoordinator() {
    if (!coordinator?.coordinator_project_id) return
    let origin: NonNullable<typeof coordinatorReviveAttempt.current> | undefined
    try {
      const runtime = activeRuntime()
      const previous = coordinatorReviveAttempt.current
      if (
        !previous ||
        previous.store !== useStore ||
        previous.runtime !== runtime ||
        previous.projectId !== coordinator.coordinator_project_id ||
        previous.threadId !== coordinator.id
      ) {
        coordinatorReviveAttempt.current = {
          store: useStore,
          runtime,
          projectId: coordinator.coordinator_project_id,
          threadId: coordinator.id,
          request: {
            operation_id: crypto.randomUUID(),
            project_id: coordinator.coordinator_project_id,
            provider: coordinator.provider,
            ...(coordinator.model ? { model: coordinator.model } : {}),
            ...(coordinator.effort ? { effort: coordinator.effort } : {}),
            permission_mode: coordinator.permission_mode,
            coordinator_mode: group.coordinator_mode,
          },
        }
      }
      origin = coordinatorReviveAttempt.current!
      const isCurrent = () => {
        if (origin!.store !== useStore) return false
        try { return activeRuntime() === origin!.runtime } catch { return false }
      }
      setBusy(true)
      setError("")
      const revived = await origin.runtime.rpc().call(
        "collaboration.coordinator.get_or_create",
        origin.request
      )
      if (!isCurrent()) return
      origin.store.getState().set((state) => ({
        threads: { ...state.threads, [revived.thread.id]: revived.thread },
      }))
      coordinatorReviveAttempt.current = null
      await load()
    } catch (cause) {
      if (origin) {
        try { if (activeRuntime() !== origin.runtime) return } catch { return }
      }
      const message = errorText(cause)
      setError(message)
      toast.error("Unable to resume coordinator", { description: message })
    } finally {
      if (!origin) setBusy(false)
      else {
        try { if (activeRuntime() === origin.runtime) setBusy(false) } catch { /* environment changed */ }
      }
    }
  }
  const allowedProviders = providers.filter(
    (provider) =>
      !group.policy.allowed_providers.length ||
      group.policy.allowed_providers.includes(provider.kind)
  )
  return (
    <>
      <div
        ref={scrollContainer}
        className="h-full overflow-y-auto text-sm"
        data-collaboration-view={view}
      >
        <div className="mx-auto min-h-full max-w-2xl px-4 pt-4 pb-10 min-[520px]:px-5">
          <header className="sticky top-0 z-10 -mx-2 mb-5 rounded-xl bg-[var(--color-background-surface)] px-2 pt-1 pb-2">
            <div className="flex min-w-0 items-start gap-3">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
                <UsersIcon className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="font-heading text-base leading-tight font-semibold">
                    {persistentCoordinator ? "Project coordinator" : "Agents"}
                  </h2>
                  <Status value={group.status} />
                </div>
                <p className={`${meta} mt-1`}>
                  {Math.max(
                    0,
                    detail.members.filter((member) => member.active).length - 1
                  )}{" "}
                  helper
                  {Math.max(
                    0,
                    detail.members.filter((member) => member.active).length - 1
                  ) === 1
                    ? ""
                    : "s"}{" "}
                  · {activeAssignments.length} active
                </p>
                {persistentCoordinator && (
                  <p className="mt-1.5 line-clamp-2 max-w-[55ch] text-[length:var(--app-font-size-ui-sm,11px)] leading-snug text-foreground/75">
                    {group.objective}
                  </p>
                )}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh agents"
                disabled={busy || loading}
                onClick={() => void load()}
              >
                {loading ? <Spinner size={14} /> : <RefreshCwIcon />}
              </Button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="More agent actions"
                    />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <ComposerPickerMenuPopup
                  align="end"
                  side="bottom"
                  className="w-52 min-w-52"
                >
                  <MenuGroup>
                    <MenuGroupLabel>Agent options</MenuGroupLabel>
                    <MenuItem onClick={() => openDialog("objective")}>
                      <PencilIcon /> Edit objective
                    </MenuItem>
                    <MenuItem onClick={() => openDialog("settings")}>
                      <SettingsIcon /> Limits and permissions
                    </MenuItem>
                    <MenuItem onClick={() => openDialog("participants")}>
                      <UsersIcon /> Manage agents
                    </MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuGroup>
                    {group.status === "active" ? (
                      <MenuItem
                        title={persistentCoordinator ? "Pause this coordinator temporarily. You can resume it with its project context intact." : undefined}
                        onClick={() =>
                          void run(() => control(group.id, "pause"))
                        }
                      >
                        <PauseOutlineIcon /> {persistentCoordinator ? "Pause agents temporarily" : "Pause agents"}
                      </MenuItem>
                    ) : group.status === "paused" ? (
                      <MenuItem
                        onClick={() =>
                          void run(() => control(group.id, "resume"))
                        }
                      >
                        <PlayOutlineIcon /> Resume agents
                      </MenuItem>
                    ) : persistentCoordinator &&
                      (group.status === "stopped" || group.status === "completed") ? (
                      <MenuItem
                        onClick={() => void revivePersistentCoordinator()}
                      >
                        <PlayOutlineIcon /> Resume coordinator
                      </MenuItem>
                    ) : group.status === "stopped" ? (
                      <MenuItem
                        onClick={() =>
                          void run(() => control(group.id, "resume"))
                        }
                      >
                        <PlayOutlineIcon /> Resume agents
                      </MenuItem>
                    ) : null}
                    {group.status !== "stopped" &&
                      group.status !== "completed" && (
                        <MenuItem
                          variant="destructive"
                          onClick={() =>
                            void run(() => control(group.id, "stop"))
                          }
                        >
                          <StopIcon /> Stop agents
                        </MenuItem>
                      )}
                    {!persistentCoordinator && group.status !== "completed" && (
                      <MenuItem
                        onClick={() =>
                          void run(() => control(group.id, "complete"))
                        }
                      >
                        <CheckCircle2Icon /> Mark all complete
                      </MenuItem>
                    )}
                  </MenuGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            </div>
            <div
              className="t-tabs mt-3 grid grid-cols-3 gap-1 rounded-lg bg-[var(--color-background-button-secondary)] p-1"
              role="tablist"
              aria-label="Agent views"
              onKeyDown={(event) => {
                const tablist = event.currentTarget
                let nextIndex: number | null = null
                if (event.key === "Home") nextIndex = 0
                else if (event.key === "End") nextIndex = collaborationViews.length - 1
                else if (
                  event.key === "ArrowLeft" ||
                  event.key === "ArrowRight"
                ) {
                  const rtl = getComputedStyle(tablist).direction === "rtl"
                  const forward = (event.key === "ArrowRight") !== rtl
                  nextIndex =
                    (collaborationViews.indexOf(view) + (forward ? 1 : -1) + collaborationViews.length) %
                    collaborationViews.length
                }
                if (nextIndex == null) return
                event.preventDefault()
                const next = collaborationViews[nextIndex]
                switchView(next)
                requestAnimationFrame(() =>
                  tablist
                    .querySelector<HTMLElement>(`[role=tab][data-view=${next}]`)
                    ?.focus()
                )
              }}
            >
              {collaborationViews.map((item) => (
                <button
                  id={`collaboration-${item}-tab`}
                  key={item}
                  data-view={item}
                  type="button"
                  role="tab"
                  tabIndex={view === item ? 0 : -1}
                  aria-selected={view === item}
                  aria-controls={`collaboration-${item}-panel`}
                  onClick={() => switchView(item)}
                  className={`relative rounded-md px-2 py-1.5 text-[length:var(--app-font-size-ui,12px)] font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring/60 ${view === item ? "bg-[var(--sidebar-accent-active)] text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {persistentCoordinator
                    ? item === "work"
                      ? "Workers"
                      : item === "context"
                        ? "Project knowledge"
                        : "Results"
                    : item === "work"
                      ? "Agents"
                      : item === "context"
                        ? "Shared notes"
                        : "Messages"}
                  {item === "work" && attentionAssignments.length > 0 && (
                    <span className="ms-1.5 inline-flex min-w-4 justify-center rounded-full bg-amber-500/16 px-1 text-[10px] text-amber-700 tabular-nums dark:text-amber-300">
                      {attentionAssignments.length}
                    </span>
                  )}
                </button>
              ))}
            </div>
            <details className="mt-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground select-none">
                How agents work
              </summary>
              <div className="mt-2 max-w-[65ch] space-y-1.5 leading-relaxed">
                <p>
                  Each Kybern helper is a real thread with its own provider,
                  conversation, and tools. Helpers can exchange messages and
                  report results here. Provider-native subagents stay inside
                  their provider thread.
                </p>
                <p>
                  Example: ask in chat, “Have Codex review this change and
                  report back.”
                </p>
              </div>
            </details>
          </header>

          {error && (
            <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {error}
            </p>
          )}
          {viewingPrevious && currentDetail && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-xs font-medium">Viewing previous agents</p>
                <p className={`${meta} mt-0.5 truncate`}>{group.objective}</p>
              </div>
              <Button
                size="xs"
                variant="secondary-outline"
                onClick={() => void showGroup(currentDetail, false)}
              >
                Return to current agents
              </Button>
            </div>
          )}
          {view === "work" && (
            <div
              id="collaboration-work-panel"
              role="tabpanel"
              aria-labelledby="collaboration-work-tab"
            >
              {threadId !== group.coordinator_thread_id && coordinator && (
                <div className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">Main thread</p>
                    <p className={`${meta} mt-0.5 truncate`}>
                      {coordinator.title || "Untitled thread"}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="secondary-outline"
                    onClick={() => selectThread(coordinator.id)}
                  >
                    Open main thread
                  </Button>
                </div>
              )}
              <ParticipantRail
                detail={detail}
                threads={threads}
                currentThreadId={threadId}
                openThread={selectThread}
                messageThread={messageThread}
                onManage={() => openDialog("participants")}
                coordinator={persistentCoordinator}
              />
              <WorkView
                assignments={[...attentionAssignments, ...quietAssignments]}
                finished={finishedAssignments}
                threads={threads}
                busy={busy}
                openThread={selectThread}
                messageThread={messageThread}
                run={run}
                groupStatus={group.status}
                history={viewingPrevious}
                onNew={() => openDialog("assignment")}
                onResume={() => void run(() => control(group.id, "resume"))}
                next={nextAssignments}
                older={olderWindow.assignments}
                more={() => void more("assignments")}
                latest={() => void load()}
                showResults={!persistentCoordinator}
              />
              <PreviousAgents
                groups={previousGroups}
                threads={threads}
                openThread={selectThread}
                onSelect={(candidate) => void showGroup(candidate, true)}
                next={nextGroups}
                busy={busy}
                onMore={() => void loadEarlierGroups()}
              />
            </div>
          )}
          {view === "messages" && (
            <div
              id="collaboration-messages-panel"
              role="tabpanel"
              aria-labelledby="collaboration-messages-tab"
            >
              <Messages
                messages={messages}
                threads={threads}
                onNew={() => openDialog("message")}
                onProgress={() => openDialog("progress")}
                next={nextMessages}
                older={olderWindow.messages}
                busy={busy}
                more={() => void more("messages")}
                latest={() => void load()}
              />
            </div>
          )}
          {view === "context" && (
            <div
              id="collaboration-context-panel"
              role="tabpanel"
              aria-labelledby="collaboration-context-tab"
            >
              <SharedContext
                entries={context}
                busy={busy}
                error={error}
                run={run}
                onNew={() => openDialog("context")}
                next={nextContext}
                older={olderWindow.context}
                more={() => void more("context")}
                latest={() => void load()}
                projectKnowledge={persistentCoordinator}
              />
            </div>
          )}
          {view === "results" && persistentCoordinator && (
            <div
              id="collaboration-results-panel"
              role="tabpanel"
              aria-labelledby="collaboration-results-tab"
            >
              <ResultsView
                finished={finishedAssignments}
                threads={threads}
                busy={busy}
                openThread={selectThread}
                messageThread={messageThread}
                run={run}
                next={nextAssignments}
                older={olderWindow.assignments}
                more={() => void more("assignments")}
                latest={() => void load()}
              />
            </div>
          )}

          <EditObjectiveDialog
            open={dialog === "objective"}
            onOpenChange={(open) => changeDialog("objective", open)}
            group={group}
            busy={busy}
            error={error}
            run={run}
          />
          <GroupSettings
            open={dialog === "settings"}
            onOpenChange={(open) => changeDialog("settings", open)}
            group={group}
            coordinator={coordinator}
            providers={allProviders}
            busy={busy}
            error={error}
            run={run}
          />
          <Participants
            open={dialog === "participants"}
            onOpenChange={(open) => changeDialog("participants", open)}
            detail={detail}
            threads={threads}
            busy={busy}
            error={error}
            openThread={selectThread}
            run={run}
          />
          <MessageAgent
            open={dialog === "message"}
            onOpenChange={(open) => changeDialog("message", open)}
            currentThreadId={threadId}
            members={detail.members}
            threads={threads}
            messageThread={messageThread}
          />
          <NewMessage
            open={dialog === "progress"}
            onOpenChange={(open) => changeDialog("progress", open)}
            groupId={group.id}
            currentThreadId={threadId}
            members={detail.members}
            threads={threads}
            busy={busy}
            error={error}
            run={run}
          />
          <ContextEditor
            open={dialog === "context"}
            onOpenChange={(open) => changeDialog("context", open)}
            groupId={group.id}
            busy={busy}
            error={error}
            run={run}
          />
        </div>
      </div>
      <StartAgentDialog
        key="start-agent"
        open={dialog === "assignment"}
        onOpenChange={(open) => changeDialog("assignment", open)}
        providers={allowedProviders}
        draft={agentDraft}
        setDraft={setAgentDraft}
        busy={busy}
        error={error}
        onStart={() => void startAgent()}
      />
    </>
  )
}

type Run = (work: () => Promise<unknown>) => Promise<void>
type OpenThread = (threadId: ThreadId) => void

function AgentsEmpty({
  error,
}: {
  error: string
}) {
  const set = useStore((state) => state.set)
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 flex size-10 items-center justify-center rounded-xl bg-[var(--color-background-button-secondary)]">
          <UsersIcon className="size-5" />
        </div>
        <h2 className="font-heading text-lg font-semibold tracking-[-0.01em]">
          No helper threads yet
        </h2>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Ask in chat for another agent to implement, research, or review part of
          the work. Kybern will add each helper here with its own conversation.
        </p>
        {error && (
          <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}
        <Button className="mt-6" onClick={() => {
          set({ rightOpen: false })
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-testid='composer-editor']")?.focus())
        }}>
          Return to chat
        </Button>
      </div>
    </div>
  )
}

function ParticipantRail({
  detail,
  threads,
  currentThreadId,
  openThread,
  messageThread,
  onManage,
  coordinator,
}: {
  detail: CollaborationGroupDetail
  threads: Thread[]
  currentThreadId: ThreadId
  openThread: OpenThread
  messageThread: OpenThread
  onManage: () => void
  coordinator?: boolean
}) {
  const visible = detail.members.flatMap((member) => {
    const thread = threads.find((item) => item.id === member.thread_id)
    return thread ? [{ member, thread }] : []
  })
  return (
    <section className="mb-7">
      <SectionHeader
        title={coordinator ? "Workers" : "Agents"}
        detail={`${Math.max(0, visible.length - 1)} helper${visible.length - 1 === 1 ? "" : "s"}`}
        action={
          <Button size="sm" onClick={onManage} variant="secondary-outline">
            <SettingsIcon /> Manage
          </Button>
        }
      />
      <div className="mt-2 divide-y divide-[color:var(--color-border-light)]">
        {visible.map(({ member, thread }) => (
          <div
            key={member.thread_id}
            className="flex min-w-0 flex-wrap items-center gap-2 py-3"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
              <ProviderMark kind={thread.provider.kind} />
            </span>
            <span className="min-w-32 flex-1">
              <strong className="block truncate text-sm font-medium">
                {thread.title || "Untitled thread"}
              </strong>
              <span className={meta}>
                {member.role === "coordinator"
                  ? "Main thread"
                  : providerName(thread.provider.kind)}{" "}
                · {statusLabel(thread.status)}
              </span>
            </span>
            {thread.id !== currentThreadId && (
              <div className="flex shrink-0 gap-1.5">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => openThread(thread.id)}
                >
                  Open thread
                </Button>
                <Button
                  size="xs"
                  variant="secondary-outline"
                  onClick={() => messageThread(thread.id)}
                >
                  <MessageCircleIcon /> Message
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function EditObjectiveDialog({
  open,
  onOpenChange,
  group,
  busy,
  error,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: CollaborationGroupDetail["group"]
  busy: boolean
  error: string
  run: Run
}) {
  const [objective, setObjective] = useState(group.objective)
  const [criteria, setCriteria] = useState(group.success_criteria.join("\n"))
  const [baseline, setBaseline] = useState({
    revision: group.revision,
    objective: group.objective,
    criteria: group.success_criteria.join("\n"),
  })
  useEffect(() => {
    if (!open) {
      const next = {
        revision: group.revision,
        objective: group.objective,
        criteria: group.success_criteria.join("\n"),
      }
      setBaseline(next)
      setObjective(next.objective)
      setCriteria(next.criteria)
    }
  }, [open, group.revision])
  const changed =
    objective.trim() !== baseline.objective || criteria !== baseline.criteria
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Edit objective</DialogTitle>
          <DialogDescription>
            Describe what the group should achieve and how you’ll know it’s
            done.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DialogError error={error} />
          <FieldLabel label="Objective">
            <Textarea
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              rows={3}
            />
          </FieldLabel>
          <FieldLabel label="Success criteria">
            <Textarea
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              placeholder="One criterion per line"
              rows={4}
            />
          </FieldLabel>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !changed || !objective.trim()}
            onClick={() =>
              void run(async () => {
                await rpc().call("collaboration.groups.update", {
                  operation_id: crypto.randomUUID(),
                  group_id: group.id,
                  expected_revision: baseline.revision,
                  ...(objective.trim() !== baseline.objective
                    ? { objective: objective.trim() }
                    : {}),
                  ...(criteria !== baseline.criteria
                    ? { success_criteria: lines(criteria) }
                    : {}),
                })
                onOpenChange(false)
              })
            }
          >
            Save objective
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function GroupSettings({
  open,
  onOpenChange,
  group,
  coordinator,
  providers,
  busy,
  error,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: CollaborationGroupDetail["group"]
  coordinator?: Thread
  providers: ProviderStatus[]
  busy: boolean
  error: string
  run: Run
}) {
  const defaults = group.policy.allowed_providers.length
    ? group.policy.allowed_providers
    : providers
        .filter((provider) => provider.available)
        .map((provider) => provider.kind)
  const [mode, setMode] = useState(group.coordinator_mode)
  const [allowed, setAllowed] = useState<ProviderKind[]>(defaults)
  const [workers, setWorkers] = useState(group.policy.max_active_workers)
  const [depth, setDepth] = useState(group.policy.max_depth)
  const [baseline, setBaseline] = useState({
    revision: group.revision,
    mode: group.coordinator_mode,
    allowed: defaults,
    workers: group.policy.max_active_workers,
    depth: group.policy.max_depth,
    policy: group.policy,
  })
  useEffect(() => {
    if (!open) {
      const next = {
        revision: group.revision,
        mode: group.coordinator_mode,
        allowed: defaults,
        workers: group.policy.max_active_workers,
        depth: group.policy.max_depth,
        policy: group.policy,
      }
      setBaseline(next)
      setMode(next.mode)
      setAllowed(next.allowed)
      setWorkers(next.workers)
      setDepth(next.depth)
    }
  }, [open, group.revision])
  const unsupported = coordinator
    ? dedicatedUnsupported(coordinator.provider.kind)
    : false
  const choices = providers.filter(
    (provider, index) =>
      providers.findIndex((item) => item.kind === provider.kind) === index
  )
  const policyChanged =
    workers !== baseline.workers ||
    depth !== baseline.depth ||
    allowed.join() !== baseline.allowed.join()
  const changed = mode !== baseline.mode || policyChanged
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Limits and permissions</DialogTitle>
          <DialogDescription>
            Choose which providers agents may use and how far they can delegate.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <DialogError error={error} />
          <div>
            <p className={dialogFieldLabelClassName}>Main thread role</p>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              <Button
                aria-pressed={mode === "ordinary"}
                variant={mode === "ordinary" ? "default" : "secondary"}
                onClick={() => setMode("ordinary")}
              >
                Can work and start helpers
              </Button>
              <Button
                aria-pressed={mode === "dedicated"}
                variant={mode === "dedicated" ? "default" : "secondary"}
                disabled={unsupported}
                onClick={() => setMode("dedicated")}
              >
                Only coordinate helpers
              </Button>
            </div>
            {unsupported && (
              <p className={`${meta} mt-2`}>
                {providerName(coordinator?.provider.kind)} cannot enforce
                coordination-only mode. Let the main thread work and start
                helpers instead.
              </p>
            )}
          </div>
          <div>
            <p className={dialogFieldLabelClassName}>Allowed providers</p>
            <div className="mt-1.5 grid gap-1">
              {choices.map((provider) => (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={allowed.includes(provider.kind)}
                  key={provider.kind}
                  disabled={
                    !provider.available && !allowed.includes(provider.kind)
                  }
                  onClick={() =>
                    setAllowed((current) =>
                      current.includes(provider.kind)
                        ? current.filter((kind) => kind !== provider.kind)
                        : [...current, provider.kind]
                    )
                  }
                  className="flex items-center gap-2 rounded-lg px-2 py-2 text-start text-sm hover:bg-[var(--color-background-button-secondary-hover)] disabled:opacity-50"
                >
                  <ProviderMark kind={provider.kind} />
                  <span className="flex-1">
                    {provider.display_name}
                    {!provider.available ? " · unavailable" : ""}
                  </span>
                  <span
                    className={`flex size-4 items-center justify-center rounded border ${allowed.includes(provider.kind) ? "border-primary bg-primary text-primary-foreground" : "border-[color:var(--color-border)]"}`}
                  >
                    {allowed.includes(provider.kind) && (
                      <CheckCircle2Icon className="size-3" />
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FieldLabel label="Active workers">
              <ChoicePicker
                ariaLabel="Active workers"
                value={String(workers)}
                label={String(workers)}
                items={Array.from({ length: 32 }, (_, index) => ({
                  value: String(index + 1),
                  label: String(index + 1),
                }))}
                onChange={(value) => setWorkers(Number(value))}
              />
            </FieldLabel>
            <FieldLabel label="Delegation depth">
              <ChoicePicker
                ariaLabel="Delegation depth"
                value={String(depth)}
                label={String(depth)}
                items={Array.from({ length: 9 }, (_, index) => ({
                  value: String(index),
                  label: String(index),
                }))}
                onChange={(value) => setDepth(Number(value))}
              />
            </FieldLabel>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              busy ||
              !changed ||
              !allowed.length ||
              (mode === "dedicated" && unsupported)
            }
            onClick={() =>
              void run(async () => {
                await releaseCoordinatorForMode(
                  coordinator,
                  group.coordinator_mode,
                  mode,
                  policyChanged
                )
                await rpc().call("collaboration.groups.update", {
                  operation_id: crypto.randomUUID(),
                  group_id: group.id,
                  expected_revision: baseline.revision,
                  ...(mode !== baseline.mode ? { coordinator_mode: mode } : {}),
                  ...(policyChanged
                    ? {
                        policy: {
                          ...baseline.policy,
                          allowed_providers: allowed,
                          max_active_workers: workers,
                          max_depth: depth,
                        },
                      }
                    : {}),
                })
                onOpenChange(false)
              })
            }
          >
            Save settings
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function Participants({
  open,
  onOpenChange,
  detail,
  threads,
  busy,
  error,
  openThread,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  detail: CollaborationGroupDetail
  threads: Thread[]
  busy: boolean
  error: string
  openThread: OpenThread
  run: Run
}) {
  const available = threads.filter(
    (thread) => !detail.members.some((member) => member.thread_id === thread.id)
  )
  const [threadId, setThreadId] = useState(available[0]?.id ?? "")
  const [role, setRole] = useState<GroupMemberRole>("worker")
  useEffect(() => {
    if (!available.some((thread) => thread.id === threadId))
      setThreadId(available[0]?.id ?? "")
  }, [available, threadId])
  const selected = available.find((thread) => thread.id === threadId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Manage agents</DialogTitle>
          <DialogDescription>
            Open an agent’s thread or add an existing project thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DialogError error={error} />
          <div className="divide-y divide-[color:var(--color-border-light)]">
            {detail.members.map((member) => {
              const thread = threads.find(
                (item) => item.id === member.thread_id
              )
              return (
                <button
                  type="button"
                  key={member.thread_id}
                  className="flex w-full items-center gap-3 py-2.5 text-start"
                  onClick={() => openThread(member.thread_id)}
                >
                  {thread && <ProviderMark kind={thread.provider.kind} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {thread?.title || member.thread_id}
                    </span>
                    <span className={meta}>
                      {member.role} ·{" "}
                      {thread
                        ? statusLabel(thread.status)
                        : member.active
                          ? "participating"
                          : "reference"}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                </button>
              )
            })}
          </div>
          {available.length ? (
            <div className="space-y-3 rounded-xl bg-[var(--color-background-elevated-secondary)] p-3">
              <p className={sectionTitle}>Attach a thread</p>
              <ChoicePicker
                ariaLabel="Thread to attach"
                value={threadId}
                label={selected?.title || "Choose thread"}
                items={available.map((thread) => ({
                  value: thread.id,
                  label: thread.title || "Untitled thread",
                  icon: <ProviderMark kind={thread.provider.kind} />,
                }))}
                onChange={setThreadId}
              />
              <ChoicePicker
                ariaLabel="Participant role"
                value={role}
                label={capitalize(role)}
                items={(
                  [
                    "worker",
                    "reviewer",
                    "integrator",
                    "observer",
                  ] as GroupMemberRole[]
                ).map((value) => ({ value, label: capitalize(value) }))}
                onChange={(value) => setRole(value as GroupMemberRole)}
              />
              <Button
                className="w-full"
                disabled={busy || !threadId}
                onClick={() =>
                  void run(async () => {
                    await rpc().call("collaboration.members.attach", {
                      operation_id: crypto.randomUUID(),
                      group_id: detail.group.id,
                      thread_id: threadId,
                      role,
                    })
                    onOpenChange(false)
                  })
                }
              >
                Attach thread
              </Button>
            </div>
          ) : (
            <Muted>All project threads are already represented.</Muted>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  )
}

function StartAgentDialog({
  open,
  onOpenChange,
  providers,
  draft,
  setDraft,
  busy,
  error,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: ProviderStatus[]
  draft: AgentDraft
  setDraft: React.Dispatch<React.SetStateAction<AgentDraft>>
  busy: boolean
  error: string
  onStart: () => void
}) {
  const provider =
    providers.find((item) => item.kind === draft.provider) ?? providers[0]
  useEffect(() => {
    if (provider && provider.kind !== draft.provider)
      setDraft((current) => ({
        ...current,
        provider: provider.kind,
        model: "",
      }))
  }, [provider?.kind, draft.provider])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Start agent</DialogTitle>
          <DialogDescription>
            Choose who should help and describe one focused task. Kybern opens a
            real thread for the work.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DialogError error={error} />
          <FieldLabel label="Provider">
            <ChoicePicker
              ariaLabel="Provider"
              value={provider?.kind || ""}
              label={provider?.display_name || "No provider available"}
              items={providers.map((item) => ({
                value: item.kind,
                label: item.display_name,
                icon: <ProviderMark kind={item.kind} />,
              }))}
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  provider: value as ProviderKind,
                  model: "",
                }))
              }
            />
          </FieldLabel>
          <FieldLabel label="Task">
            <Textarea
              autoFocus
              value={draft.task}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  task: event.target.value,
                }))
              }
              rows={5}
              placeholder="Review the authentication changes and report any security issues."
            />
          </FieldLabel>
          {provider?.models?.length ? (
            <FieldLabel label="Model (optional)">
              <ChoicePicker
                ariaLabel="Model"
                value={draft.model}
                label={
                  provider.models.find((item) => item.id === draft.model)
                    ?.display_name || "Provider default"
                }
                items={[
                  { value: "", label: "Provider default" },
                  ...provider.models.map((item) => ({
                    value: item.id,
                    label: item.display_name,
                  })),
                ]}
                onChange={(value) =>
                  setDraft((current) => ({ ...current, model: value }))
                }
              />
            </FieldLabel>
          ) : null}
          <p className={meta}>
            Editing and integration tasks start in a separate Git workspace;
            uncommitted changes aren’t included. Research and review can also
            start in projects without Git.
          </p>
          <details
            open={draft.advanced}
            onToggle={(event) => {
              const advanced = event.currentTarget.open
              setDraft((current) => ({ ...current, advanced }))
            }}
            className="rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5"
          >
            <summary className="cursor-pointer text-xs font-medium select-none">
              Advanced
            </summary>
            <div className="mt-4 space-y-4">
              <FieldLabel label="Title (optional)">
                <Input
                  value={draft.title}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder="Derived from the task"
                />
              </FieldLabel>
              <div className="grid grid-cols-2 gap-3">
                <FieldLabel label="Kind">
                  <ChoicePicker
                    ariaLabel="Assignment kind"
                    value={draft.kind}
                    label={capitalize(draft.kind)}
                    items={(
                      [
                        "edit",
                        "review",
                        "research",
                        "integration",
                        "coordination",
                      ] as AssignmentKind[]
                    ).map((value) => ({ value, label: capitalize(value) }))}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        kind: value as AssignmentKind,
                      }))
                    }
                  />
                </FieldLabel>
                <FieldLabel label="Base revision">
                  <Input
                    value={draft.baseRevision}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        baseRevision: event.target.value,
                      }))
                    }
                    placeholder="Current branch"
                  />
                </FieldLabel>
              </div>
              <p className={meta}>
                The agent starts from the current branch unless you name another
                branch or commit.
              </p>
            </div>
          </details>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !provider || !draft.task.trim()}
            onClick={onStart}
          >
            {busy ? "Starting…" : "Start agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function WorkView({
  assignments,
  finished,
  threads,
  busy,
  openThread,
  messageThread,
  run,
  groupStatus,
  history,
  onNew,
  onResume,
  next,
  older,
  more,
  latest,
  showResults = true,
}: {
  assignments: CollaborationAssignment[]
  finished: CollaborationAssignment[]
  threads: Thread[]
  busy: boolean
  openThread: OpenThread
  messageThread: OpenThread
  run: Run
  groupStatus: CollaborationGroupDetail["group"]["status"]
  history: boolean
  onNew: () => void
  onResume: () => void
  next: string | null
  older: boolean
  more: () => void
  latest: () => void
  showResults?: boolean
}) {
  const canStart =
    !history && (groupStatus === "active" || groupStatus === "completed")
  const canResume =
    !history && (groupStatus === "paused" || groupStatus === "stopped")
  const newAction = canStart ? (
    <Button size="sm" onClick={onNew}>
      <PlusIcon /> Start agent
    </Button>
  ) : canResume ? (
    <Button size="sm" onClick={onResume}>
      <PlayOutlineIcon /> Resume agents
    </Button>
  ) : undefined
  return (
    <div className="space-y-7">
      {(assignments.length > 0 || canStart || canResume) && (
        <section>
          <SectionHeader
            title="Work"
            detail={`${assignments.length} active task${assignments.length === 1 ? "" : "s"}`}
            action={newAction}
          />
          {assignments.length ? (
            <div className="divide-y divide-[color:var(--color-border-light)]">
              {assignments.map((assignment) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  threads={threads}
                  busy={busy}
                  openThread={openThread}
                  messageThread={messageThread}
                  run={run}
                />
              ))}
            </div>
          ) : canStart ? (
            <EmptyState
              title="No active tasks"
              body={groupStatus === "completed"
                ? "Start an agent for a new task. Earlier results stay available."
                : "Ask this thread to start a helper, or choose Start agent yourself."}
              action={null}
            />
          ) : canResume ? (
            <EmptyState
              title={
                groupStatus === "paused"
                  ? "Agents are paused"
                  : "Agents are stopped"
              }
              body="Resume agents before starting another helper."
              action={null}
            />
          ) : null}
        </section>
      )}
      {showResults && finished.length > 0 ? (
        <section>
          <SectionHeader
            title="Recent results"
            detail={`${finished.length} finished`}
          />
          <div className="divide-y divide-[color:var(--color-border-light)]">
            {finished.map((assignment) => (
              <AssignmentRow
                key={assignment.id}
                assignment={assignment}
                threads={threads}
                busy={busy}
                openThread={openThread}
                messageThread={messageThread}
                run={run}
              />
            ))}
          </div>
        </section>
      ) : showResults && !canStart ? (
        <EmptyState
          title="No results recorded"
          body={
            history
              ? "This previous agent group has no saved task results."
              : "Results will appear here as agents finish their tasks."
          }
          action={null}
        />
      ) : null}
      <Paging
        next={next}
        older={older}
        busy={busy}
        noun="tasks"
        more={more}
        latest={latest}
      />
    </div>
  )
}

function ResultsView({
  finished,
  threads,
  busy,
  openThread,
  messageThread,
  run,
  next,
  older,
  more,
  latest,
}: {
  finished: CollaborationAssignment[]
  threads: Thread[]
  busy: boolean
  openThread: OpenThread
  messageThread: OpenThread
  run: Run
  next: string | null
  older: boolean
  more: () => void
  latest: () => void
}) {
  return (
    <div className="space-y-6">
      <SectionHeader
        title="Returned work"
        detail="Review completed and failed worker tasks before deciding what happens next"
      />
      {finished.length ? (
        <div className="divide-y divide-[color:var(--color-border-light)]">
          {finished.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              threads={threads}
              busy={busy}
              openThread={openThread}
              messageThread={messageThread}
              run={run}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No returned work yet"
          body="Worker summaries, checks, changed files, artifacts, and unresolved questions appear here when tasks finish."
          action={null}
        />
      )}
      <Paging next={next} older={older} busy={busy} noun="results" more={more} latest={latest} />
    </div>
  )
}

function PreviousAgents({
  groups,
  threads,
  openThread,
  onSelect,
  next,
  busy,
  onMore,
}: {
  groups: CollaborationGroupDetail[]
  threads: Thread[]
  openThread: OpenThread
  onSelect: (group: CollaborationGroupDetail) => void
  next: string | null
  busy: boolean
  onMore: () => void
}) {
  if (!groups.length && !next) return null
  return (
    <details className="mt-7 rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5">
      <summary className="cursor-pointer text-xs font-medium select-none">
        Previous agents
      </summary>
      <div className="mt-3 space-y-4">
        {groups.map((detail) => {
          const helpers = detail.members.filter(
            (member) => member.thread_id !== detail.group.coordinator_thread_id
          )
          return (
            <section key={detail.group.id}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-start text-xs font-medium outline-none hover:underline focus-visible:underline"
                  onClick={() => onSelect(detail)}
                >
                  {detail.group.objective}
                </button>
                <Status value={detail.group.status} />
                <Button
                  size="xs"
                  variant="secondary-outline"
                  onClick={() => onSelect(detail)}
                >
                  View
                </Button>
              </div>
              {helpers.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {helpers.map((member) => {
                    const thread = threads.find(
                      (item) => item.id === member.thread_id
                    )
                    return thread ? (
                      <Button
                        key={thread.id}
                        size="xs"
                        variant="ghost"
                        onClick={() => openThread(thread.id)}
                      >
                        <ProviderMark kind={thread.provider.kind} size={12} />{" "}
                        {thread.title || "Untitled thread"}
                      </Button>
                    ) : null
                  })}
                </div>
              )}
            </section>
          )
        })}
        {next && (
          <Button size="xs" variant="ghost" disabled={busy} onClick={onMore}>
            Load earlier agents
          </Button>
        )}
      </div>
    </details>
  )
}

function AssignmentRow({
  assignment,
  threads,
  busy,
  openThread,
  messageThread,
  run,
}: {
  assignment: CollaborationAssignment
  threads: Thread[]
  busy: boolean
  openThread: OpenThread
  messageThread: OpenThread
  run: Run
}) {
  const [expanded, setExpanded] = useState(false)
  const owner = threads.find(
    (thread) => thread.id === assignment.owner_thread_id
  )
  const kind = owner?.provider.kind ?? assignment.requested_child?.provider.kind
  const ownerTitle =
    owner?.title && owner.title !== assignment.title ? owner.title : ""
  return (
    <article className="py-3">
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label={`${expanded ? "Hide" : "Show"} details for ${assignment.title}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="group flex min-w-0 flex-1 items-start gap-3 rounded-lg text-start outline-none hover:bg-[var(--color-background-button-secondary)]/45 focus-visible:ring-1 focus-visible:ring-ring/60"
        >
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
            {kind ? (
              <ProviderMark kind={kind} />
            ) : (
              <UsersIcon className="size-3.5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <strong className="block truncate text-sm font-medium">
              {assignment.title}
            </strong>
            <span
              className={`${meta} mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1`}
              title={ownerTitle || undefined}
            >
              <span>{kind ? providerName(kind) : "Starting agent"}</span>
              <span>·</span>
              <span>{capitalize(assignment.kind)}</span>
              {assignment.requested_child?.model && (
                <>
                  <span>·</span>
                  <span className="truncate">
                    {assignment.requested_child.model}
                  </span>
                </>
              )}
              {ownerTitle && (
                <>
                  <span>·</span>
                  <span className="max-w-40 truncate">{ownerTitle}</span>
                </>
              )}
              <Status
                value={assignment.status}
                attention={assignmentNeedsAttention(assignment)}
              />
              {DONE.has(assignment.status) &&
                assignment.result?.outcome === "partial" && (
                  <Status value="needs review" attention />
                )}
            </span>
            <span
              data-assignment-summary
              className="mt-1.5 line-clamp-2 max-w-[65ch] text-xs leading-relaxed break-words text-muted-foreground"
            >
              {assignment.result?.summary ||
                assignment.uncertainty ||
                assignment.instructions}
            </span>
          </span>
          <ChevronRightIcon
            className={`mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--duration-quick)] motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
          />
        </button>
        {assignment.owner_thread_id && (
          <div className="flex shrink-0 gap-1">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => openThread(assignment.owner_thread_id!)}
            >
              Open thread
            </Button>
            <Button
              size="xs"
              variant="secondary-outline"
              onClick={() => messageThread(assignment.owner_thread_id!)}
            >
              <MessageCircleIcon /> Message
            </Button>
          </div>
        )}
      </div>
      {expanded && (
        <div className="ms-10 mt-3 max-w-[65ch] space-y-3 text-xs leading-relaxed">
          <DetailBlock
            title="Instructions"
            values={[assignment.instructions]}
          />
          {assignment.uncertainty && (
            <DetailBlock
              title="Needs attention"
              values={[assignment.uncertainty]}
              tone="attention"
            />
          )}
          {assignment.result && (
            <>
              <DetailBlock
                title={`${capitalize(assignment.result.outcome)} result`}
                values={[assignment.result.summary]}
              />
              <DetailBlock title="Changes" values={assignment.result.changes} />
              <DetailBlock title="Checks" values={assignment.result.checks} />
              <DetailBlock
                title="Artifacts"
                values={assignment.result.artifacts}
              />
              <DetailBlock
                title="Unresolved"
                values={assignment.result.unresolved}
                tone="attention"
              />
            </>
          )}
          {!DONE.has(assignment.status) && (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  rpc().call("collaboration.assignments.cancel", {
                    operation_id: crypto.randomUUID(),
                    assignment_id: assignment.id,
                    reason: "Cancelled by the user",
                  })
                )
              }
            >
              Cancel task
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function Messages({
  messages,
  threads,
  onNew,
  onProgress,
  next,
  older,
  busy,
  more,
  latest,
}: {
  messages: CollaborationMessage[]
  threads: Thread[]
  onNew: () => void
  onProgress: () => void
  next: string | null
  older: boolean
  busy: boolean
  more: () => void
  latest: () => void
}) {
  const ordered = [...messages].sort(
    (a, b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
  )
  return (
    <div className="space-y-4">
      <SectionHeader
        title="Messages"
        detail={
          messages.length
            ? "Agent-to-agent messages · newest first"
            : "Questions, replies, progress, and results between agents"
        }
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="secondary-outline" onClick={onProgress}>
              Save note
            </Button>
            <Button size="sm" onClick={onNew}>
              <MessageCircleIcon /> Message agent
            </Button>
          </div>
        }
      />
      {ordered.length ? (
        <div className="divide-y divide-[color:var(--color-border-light)]">
          {ordered.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              reply={
                message.reply_to
                  ? messages.find(
                      (candidate) => candidate.id === message.reply_to
                    )
                  : undefined
              }
              threads={threads}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title="No agent messages yet"
          body="Open an agent’s thread to send a normal message. Questions and results exchanged by agents will appear here."
          action={
            <Button size="sm" onClick={onNew}>
              Message agent
            </Button>
          }
        />
      )}
      <Paging
        next={next}
        older={older}
        busy={busy}
        noun="messages"
        more={more}
        latest={latest}
      />
    </div>
  )
}

function MessageRow({
  message,
  reply,
  threads,
}: {
  message: CollaborationMessage
  reply?: CollaborationMessage
  threads: Thread[]
}) {
  const [expanded, setExpanded] = useState(false)
  const sender = threads.find((thread) => thread.id === message.from_thread_id)
  const recipient = threads.find((thread) => thread.id === message.to_thread_id)
  const senderName =
    sender?.title ||
    (message.from_thread_id ? message.from_thread_id.slice(0, 8) : "You")
  const recipientName = recipient?.title || message.to_thread_id.slice(0, 8)
  return (
    <article className="py-3">
      <button
        type="button"
        aria-label={`${expanded ? "Hide" : "Show"} full message from ${senderName}`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start gap-3 rounded-lg text-start outline-none hover:bg-[var(--color-background-button-secondary)]/45 focus-visible:ring-1 focus-visible:ring-ring/60"
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-button-secondary)]">
          {sender ? (
            <ProviderMark kind={sender.provider.kind} />
          ) : (
            <MessageCircleIcon className="size-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <strong
              className="max-w-[42%] truncate font-medium"
              title={senderName}
            >
              {senderName}
            </strong>
            <span className="shrink-0 text-muted-foreground">to</span>
            <strong
              className="min-w-0 flex-1 truncate font-medium"
              title={recipientName}
            >
              {recipientName}
            </strong>
            <Status value={message.purpose} />
          </span>
          <span className={`${meta} mt-1 flex items-center gap-1.5`}>
            <time dateTime={message.created_at}>
              {formatMessageTime(message.created_at)}
            </time>
            <span>·</span>
            <span>{messageStateLabel(message)}</span>
          </span>
          {!expanded && (
            <span
              data-message-preview
              className="mt-1.5 line-clamp-3 max-w-[65ch] text-sm leading-relaxed break-words whitespace-pre-wrap"
            >
              {message.body}
            </span>
          )}
        </span>
        <ChevronRightIcon
          className={`mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-[var(--duration-quick)] motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      </button>
      {expanded && (
        <div className="ms-10 mt-3 max-w-[65ch] space-y-3 text-sm leading-relaxed">
          <p className="break-words whitespace-pre-wrap">{message.body}</p>
          {reply && (
            <div className="rounded-lg bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-xs">
              <p className={meta}>
                In reply to {threadName(threads, reply.from_thread_id) || "you"}
              </p>
              <p className="mt-1 line-clamp-4 break-words whitespace-pre-wrap">
                {reply.body}
              </p>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function MessageAgent({
  open,
  onOpenChange,
  currentThreadId,
  members,
  threads,
  messageThread,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentThreadId: string
  members: GroupMember[]
  threads: Thread[]
  messageThread: OpenThread
}) {
  const targets = members.filter(
    (member) => member.active && member.thread_id !== currentThreadId
  )
  const [target, setTarget] = useState(targets[0]?.thread_id ?? "")
  useEffect(() => {
    if (!targets.some((member) => member.thread_id === target))
      setTarget(targets[0]?.thread_id ?? "")
  }, [targets, target])
  const recipient = threads.find((thread) => thread.id === target)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Message agent</DialogTitle>
          <DialogDescription>
            Open the agent’s real thread and continue the conversation in its
            normal composer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <FieldLabel label="Agent">
            <ChoicePicker
              ariaLabel="Agent to message"
              value={target}
              label={recipient?.title || "Choose agent"}
              items={targets.map((member) => {
                const thread = threads.find(
                  (item) => item.id === member.thread_id
                )
                return {
                  value: member.thread_id,
                  label: thread?.title || member.thread_id,
                  icon: thread ? (
                    <ProviderMark kind={thread.provider.kind} />
                  ) : undefined,
                }
              })}
              onChange={setTarget}
            />
          </FieldLabel>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={!target}
            onClick={() => {
              onOpenChange(false)
              messageThread(target)
            }}
          >
            Open thread
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function NewMessage({
  open,
  onOpenChange,
  groupId,
  currentThreadId,
  members,
  threads,
  busy,
  error,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  currentThreadId: string
  members: GroupMember[]
  threads: Thread[]
  busy: boolean
  error: string
  run: Run
}) {
  const targets = members.filter(
    (member) => member.active && member.thread_id !== currentThreadId
  )
  const [target, setTarget] = useState(targets[0]?.thread_id ?? "")
  const [body, setBody] = useState("")
  const recipient = threads.find((thread) => thread.id === target)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Save progress note</DialogTitle>
          <DialogDescription>
            This is an informational note in the agent message log. It does not
            interrupt or wake the recipient.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DialogError error={error} />
          <FieldLabel label="Agent">
            <ChoicePicker
              ariaLabel="Note recipient"
              value={target}
              label={recipient?.title || "Choose agent"}
              items={targets.map((member) => {
                const thread = threads.find(
                  (item) => item.id === member.thread_id
                )
                return {
                  value: member.thread_id,
                  label: thread?.title || member.thread_id,
                  icon: thread ? (
                    <ProviderMark kind={thread.provider.kind} />
                  ) : undefined,
                }
              })}
              onChange={setTarget}
            />
          </FieldLabel>
          <FieldLabel label="Note">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              placeholder="What changed or what should they know?"
            />
          </FieldLabel>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !target || !body.trim()}
            onClick={() =>
              void run(async () => {
                await rpc().call("collaboration.messages.send", {
                  operation_id: crypto.randomUUID(),
                  group_id: groupId,
                  to_thread_id: target,
                  purpose: "progress",
                  body: body.trim(),
                })
                setBody("")
                onOpenChange(false)
              })
            }
          >
            Save note
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function SharedContext({
  entries,
  busy,
  error,
  run,
  onNew,
  next,
  older,
  more,
  latest,
  projectKnowledge = false,
}: {
  entries: ContextEntry[]
  busy: boolean
  error: string
  run: Run
  onNew: () => void
  next: string | null
  older: boolean
  more: () => void
  latest: () => void
  projectKnowledge?: boolean
}) {
  const [history, setHistory] = useState<Record<string, ContextEntry[]>>({})
  const [historyCursor, setHistoryCursor] = useState<
    Record<string, number | null>
  >({})
  const [historyError, setHistoryError] = useState<Record<string, string>>({})
  const [olderHistory, setOlderHistory] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<ContextEntry | null>(null)
  const plans = entries.filter((entry) => entry.kind === "plan")
  const instructions = entries.filter(
    (entry) => entry.kind !== "plan" && (entry.user_authored || entry.kind === "instruction")
  )
  const observations = entries.filter((entry) => !plans.includes(entry) && !instructions.includes(entry))
  const fetchHistory = async (entry: ContextEntry, append = false) => {
    setExpanded(entry.id)
    setHistoryError((current) => ({ ...current, [entry.id]: "" }))
    try {
      const result = await rpc().call("collaboration.context.history", {
        entry_id: entry.id,
        ...(append && historyCursor[entry.id] != null
          ? { before_revision: historyCursor[entry.id]! }
          : {}),
        limit: 20,
      })
      setHistory((current) => {
        const combined = append
          ? [...(current[entry.id] ?? []), ...result.revisions]
          : result.revisions
        setOlderHistory((value) => ({
          ...value,
          [entry.id]: combined.length > 200,
        }))
        return { ...current, [entry.id]: combined.slice(-200) }
      })
      setHistoryCursor((current) => ({
        ...current,
        [entry.id]: result.next_before_revision ?? null,
      }))
      setExpanded(entry.id)
    } catch (cause) {
      setHistoryError((current) => ({
        ...current,
        [entry.id]: `Couldn’t load revision history. Try again. ${errorText(cause)}`,
      }))
    }
  }
  const list = (items: ContextEntry[]) =>
    items.length ? (
      <div className="divide-y divide-[color:var(--color-border-light)]">
        {items.map((entry) => (
          <article key={entry.id} className="py-3">
            <button
              type="button"
              aria-expanded={expanded === entry.id}
              className="flex w-full items-start gap-3 rounded-lg text-start outline-none hover:bg-[var(--color-background-button-secondary)]/45 focus-visible:ring-1 focus-visible:ring-ring/60"
              onClick={() =>
                expanded === entry.id
                  ? setExpanded(null)
                  : void fetchHistory(entry)
              }
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm font-medium">{entry.key}</strong>
                  <Status value={entry.kind} />
                </span>
                {expanded !== entry.id && (
                  <span className="mt-1.5 line-clamp-3 max-w-[65ch] text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                    {entry.body}
                  </span>
                )}
              </span>
              <span className={`${meta} shrink-0 tabular-nums`}>
                r{entry.revision}
              </span>
              <ChevronRightIcon
                className={`mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded === entry.id ? "rotate-90" : ""}`}
              />
            </button>
            {historyError[entry.id] && (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
              >
                {historyError[entry.id]}
              </p>
            )}
            {expanded === entry.id && (
              <div className="ms-3 mt-3 max-w-[65ch] space-y-3 border-s border-[color:var(--color-border)] ps-4">
                <div>
                  <p className={meta}>Current revision {entry.revision}</p>
                  <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
                    {entry.body}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="secondary-outline"
                  onClick={() => setEditing(entry)}
                >
                  {entry.user_authored ? "Edit note" : "Correct note"}
                </Button>
                {history[entry.id]
                  ?.filter((revision) => revision.revision !== entry.revision)
                  .map((revision) => (
                    <div
                      key={revision.revision}
                      className="text-xs leading-relaxed"
                    >
                      <p className={meta}>
                        Revision {revision.revision} ·{" "}
                        {revision.user_authored
                          ? "User instruction"
                          : "Agent observation"}
                      </p>
                      <p className="mt-1 break-words whitespace-pre-wrap">
                        {revision.body}
                      </p>
                    </div>
                  ))}
                {historyCursor[entry.id] != null && (
                  <Button
                    size="xs"
                    variant="secondary-outline"
                    onClick={() => void fetchHistory(entry, true)}
                  >
                    Load earlier revisions
                  </Button>
                )}
                {olderHistory[entry.id] && (
                  <Button
                    size="xs"
                    variant="secondary-outline"
                    onClick={() => void fetchHistory(entry)}
                  >
                    Return to current revision
                  </Button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    ) : (
      <Muted>None recorded.</Muted>
    )
  return (
    <div className="space-y-6">
      <SectionHeader
        title={projectKnowledge ? "Project knowledge" : "Shared notes"}
        detail={projectKnowledge ? "The coordinator autosaves its plan and useful findings here. Your instructions and corrections take authority; earlier revisions remain available." : "Optional instructions and findings that every agent can read"}
        action={entries.length || !projectKnowledge ?
          <Button size="sm" onClick={onNew}>
            <PlusIcon /> Add note
          </Button>
          : null}
      />
      {entries.length ? (
        <>
          {plans.length > 0 && (
            <section>
              <h3 className={sectionTitle}>Current plan</h3>
              {list(plans)}
            </section>
          )}
          <section>
            <h3 className={sectionTitle}>Your instructions</h3>
            {list(instructions)}
          </section>
          {observations.length > 0 && (
            <section>
              <h3 className={sectionTitle}>Agent notes</h3>
              {list(observations)}
            </section>
          )}
        </>
      ) : (
        <EmptyState
          title={projectKnowledge ? "No project knowledge saved" : "No shared notes"}
          body={projectKnowledge ? "Add an instruction or correction now. The coordinator’s plan and autosaved findings will appear here as work progresses." : "Add an optional instruction, decision, or finding when every agent should have the same context."}
          action={
            <Button size="sm" onClick={onNew}>
              Add note
            </Button>
          }
        />
      )}
      <Paging
        next={next}
        older={older}
        busy={busy}
        noun="notes"
        more={more}
        latest={latest}
      />
      {editing && (
        <ContextEditor
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          groupId={editing.group_id}
          initial={editing}
          busy={busy}
          error={error}
          run={run}
        />
      )}
    </div>
  )
}

function ContextEditor({
  open,
  onOpenChange,
  groupId,
  initial,
  busy,
  error,
  run,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  initial?: ContextEntry
  busy: boolean
  error: string
  run: Run
}) {
  const [key, setKey] = useState(initial?.key ?? "")
  const [body, setBody] = useState(initial?.body ?? "")
  const [kind, setKind] = useState<ContextEntryKind>(
    initial?.kind ?? "instruction"
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {initial ? (initial.user_authored ? "Edit shared note" : "Correct shared note") : "Add shared note"}
          </DialogTitle>
          <DialogDescription>
            {initial && !initial.user_authored
              ? "Save your correction as the authoritative revision. The agent’s earlier version remains in history."
              : "Save optional instructions or knowledge that every agent can read. Earlier revisions remain available."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DialogError error={error} />
          <FieldLabel label="Name">
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="For example, test environment"
            />
          </FieldLabel>
          <FieldLabel label="Content">
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={6}
              placeholder="What should every agent know?"
            />
          </FieldLabel>
          <details className="rounded-xl bg-[var(--color-background-elevated-secondary)] px-3 py-2.5">
            <summary className="cursor-pointer text-xs font-medium select-none">
              Advanced
            </summary>
            <div className="mt-3">
              <FieldLabel label="Note kind">
                <ChoicePicker
                  ariaLabel="Note kind"
                  value={kind}
                  label={capitalize(kind.replace("_", " "))}
                  items={(
                    [
                      "instruction",
                      "plan",
                      "decision",
                      "brief",
                      "research",
                      "result_reference",
                    ] as ContextEntryKind[]
                  ).map((value) => ({
                    value,
                    label: capitalize(value.replace("_", " ")),
                  }))}
                  onChange={(value) => setKind(value as ContextEntryKind)}
                />
              </FieldLabel>
            </div>
          </details>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="secondary-outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !key.trim() || !body.trim()}
            onClick={() =>
              void run(async () => {
                await rpc().call("collaboration.context.put", {
                  operation_id: crypto.randomUUID(),
                  group_id: groupId,
                  ...(initial
                    ? {
                        entry_id: initial.id,
                        expected_revision: initial.revision,
                      }
                    : {}),
                  key: key.trim(),
                  kind,
                  body: body.trim(),
                  user_authored: true,
                })
                onOpenChange(false)
              })
            }
          >
            {initial ? "Save note" : "Add note"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function ChoicePicker({
  ariaLabel,
  value,
  label,
  items,
  onChange,
}: {
  ariaLabel: string
  value: string
  label: string
  items: { value: string; label: string; icon?: React.ReactNode }[]
  onChange: (value: string) => void
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="secondary-outline"
            className="w-full min-w-0 justify-between font-normal"
            aria-label={ariaLabel}
          />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="size-3.5" />
      </MenuTrigger>
      <ComposerPickerMenuPopup
        align="start"
        side="bottom"
        className="min-w-[var(--anchor-width)]"
      >
        <MenuGroup>
          <MenuGroupLabel>{ariaLabel}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={onChange}>
            {items.map((item) => (
              <MenuRadioItem key={item.value || "default"} value={item.value}>
                {item.icon}
                {item.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  )
}

function FieldLabel({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block space-y-1.5">
      <span className={dialogFieldLabelClassName}>{label}</span>
      {children}
    </label>
  )
}
function SectionHeader({
  title,
  detail,
  action,
}: {
  title: string
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <h3 className={sectionTitle}>{title}</h3>
        {detail && <p className={`${meta} mt-0.5`}>{detail}</p>}
      </div>
      {action}
    </div>
  )
}
function EmptyState({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action: React.ReactNode
}) {
  return (
    <div className="rounded-xl bg-[var(--color-background-elevated-secondary)] px-4 py-5 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        {body}
      </p>
      <div className="mt-3">{action}</div>
    </div>
  )
}
function DialogError({ error }: { error: string }) {
  return error ? (
    <p
      role="alert"
      className="rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive"
    >
      {error}
    </p>
  ) : null
}
function DetailBlock({
  title,
  values,
  tone,
}: {
  title: string
  values: string[]
  tone?: "attention"
}) {
  if (!values.length) return null
  return (
    <div>
      <p
        className={`${meta} font-medium ${tone === "attention" ? "text-amber-700 dark:text-amber-300" : ""}`}
      >
        {title}
      </p>
      {values.length === 1 ? (
        <p className="mt-1 break-words whitespace-pre-wrap text-foreground">
          {values[0]}
        </p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 ps-4 text-foreground">
          {values.map((value) => (
            <li key={value} className="break-words">
              {value}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
function Paging({
  next,
  older,
  busy,
  noun,
  more,
  latest,
}: {
  next: string | null
  older: boolean
  busy: boolean
  noun: string
  more: () => void
  latest: () => void
}) {
  if (!next && !older) return null
  return (
    <div className="flex justify-center gap-2 pt-1">
      {next && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={more}>
          Load earlier {noun}
        </Button>
      )}
      {older && (
        <Button size="xs" variant="ghost" disabled={busy} onClick={latest}>
          Return to latest
        </Button>
      )}
    </div>
  )
}
function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-3 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}
function Status({
  value,
  attention = false,
}: {
  value: string
  attention?: boolean
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] leading-none ${attention ? "bg-amber-500/14 text-amber-700 dark:text-amber-300" : "bg-[var(--color-background-button-secondary)] text-muted-foreground"}`}
    >
      {capitalize(value.replaceAll("_", " "))}
    </span>
  )
}
function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}
function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}
function providerName(kind?: ProviderKind) {
  return kind === "claude-code"
    ? "Claude"
    : kind
      ? capitalize(kind)
      : "This agent"
}
function statusLabel(value: Thread["status"]) {
  return value === "awaiting-approval" ? "Needs approval" : capitalize(value)
}
function threadName(threads: Thread[], id?: string | null) {
  return (
    threads.find((thread) => thread.id === id)?.title ||
    (id ? id.slice(0, 8) : "")
  )
}
function messageStateLabel(message: CollaborationMessage) {
  if (message.state === "persisted") return "Saved"
  if (message.state === "answered") return "Answered"
  if (message.state === "failed") return "Delivery failed"
  if (message.state === "cancelled") return "Cancelled"
  if (message.state === "uncertain") return "Delivery uncertain"
  if (
    message.purpose === "question" &&
    (message.state === "submitted" || message.state === "queued")
  )
    return "Waiting for reply"
  if (message.state === "queued") return "Sending"
  return "Delivered"
}
function formatMessageTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date)
}
function control(
  groupId: string,
  action: "pause" | "stop" | "resume" | "complete"
) {
  return rpc().call("collaboration.groups.control", {
    operation_id: crypto.randomUUID(),
    group_id: groupId,
    action,
  })
}
