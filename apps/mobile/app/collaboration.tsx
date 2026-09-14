import { randomUUID } from "expo-crypto";
import { Stack, router, useLocalSearchParams } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import {
  Modal,
  Platform,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MorphingBackdrop, MorphingSurface } from "../src/components/liquid/MorphingSurface";
import { shouldReloadCollaboration } from "../../../packages/kybern-client/src/collaboration";
import { createAgentStarter } from "../../../packages/kybern-client/src/agentStart";

import type {
  AssignmentKind,
  AssignmentResult,
  AssignmentStatus,
  CollaborationAssignment,
  CollaborationGroupDetail,
  CollaborationMessage,
  ContextEntry,
  ContextEntryKind,
  GroupMemberRole,
  ProviderKind,
  ProviderStatus,
  Thread,
  ThreadEvent,
} from "../src/state/protocol";
import {
  errorText,
  rpc,
  subscribeCollaboration,
  useApp,
} from "../src/state/runtime";
import {
  Button,
  ErrorBanner,
  Field,
  Icon,
  IconButton,
  Page,
  T,
  Tap,
  styles,
} from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { space, useTheme } from "../src/ui/theme";

type WorkspaceTab = "work" | "messages" | "context" | "results";
type SheetKind =
  | "setup"
  | "objective"
  | "manage"
  | "settings"
  | "participants"
  | "assignment"
  | "message"
  | "context";
type StatusTone =
  | "ink"
  | "secondary"
  | "muted"
  | "accent"
  | "positive"
  | "negative"
  | "inverse"
  | "warning";

const finished = new Set<AssignmentStatus>([
  "completed",
  "failed",
  "cancelled",
]);
const lineList = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const dedicatedUnsupported = (kind: ProviderKind) =>
  kind === "codex" || kind === "cursor";

const assignmentKindLabels: Record<AssignmentKind, string> = {
  research: "Research",
  review: "Review",
  edit: "Edit",
  integration: "Integration",
  coordination: "Coordination",
};
const contextKindLabels: Record<ContextEntryKind, string> = {
  plan: "Plan",
  instruction: "Instruction",
  decision: "Decision",
  brief: "Brief",
  research: "Research",
  result_reference: "Result reference",
};
const roleLabels: Record<Exclude<GroupMemberRole, "coordinator">, string> = {
  worker: "Worker",
  reviewer: "Reviewer",
  integrator: "Integrator",
  observer: "Observer",
};

function sentenceCase(value: string) {
  const known: Record<string, string> = {
    pending: "Queued",
    working: "Working",
    waiting: "Waiting",
    blocked: "Blocked",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    attention_needed: "Needs attention",
    active: "Active",
    paused: "Paused",
    stopped: "Stopped",
  };
  return (
    known[value] ??
    value
      .replaceAll("_", " ")
      .replace(/^./, (character) => character.toUpperCase())
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function card(colors: ReturnType<typeof useTheme>["colors"]): ViewStyle {
  return {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    boxShadow: "0 3px 14px #00000010",
  };
}

function SurfaceCard({
  children,
  style,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const { colors } = useTheme();
  return <View style={[card(colors), style]}>{children}</View>;
}

function SectionCard({
  title,
  action,
  children,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <View style={{ gap: 10 }}>
      <View style={[styles.spread, { paddingHorizontal: 2 }]}>
        <T variant="label" tone="secondary">
          {title}
        </T>
        {action}
      </View>
      <SurfaceCard style={{ padding: 14, gap: 8 }}>{children}</SurfaceCard>
    </View>
  );
}

function statusMeta(status: string): {
  label: string;
  tone: StatusTone;
  background: string;
} {
  switch (status) {
    case "working":
    case "active":
      return { label: sentenceCase(status), tone: "positive", background: "positive" };
    case "blocked":
    case "attention_needed":
    case "awaiting-approval":
      return { label: sentenceCase(status), tone: "warning", background: "warning" };
    case "failed":
      return { label: "Failed", tone: "negative", background: "negative" };
    case "completed":
      return { label: "Completed", tone: "accent", background: "accent" };
    case "cancelled":
      return { label: "Cancelled", tone: "secondary", background: "raised" };
    case "paused":
    case "stopped":
      return { label: sentenceCase(status), tone: "secondary", background: "raised" };
    default:
      return { label: sentenceCase(status), tone: "secondary", background: "raised" };
  }
}

function StatusPill({ status }: { status: string }) {
  const { colors } = useTheme();
  const meta = statusMeta(status);
  const backgroundColor =
    meta.background === "positive"
      ? `${colors.positive}1A`
      : meta.background === "warning"
        ? colors.warningSoft
        : meta.background === "negative"
          ? `${colors.negative}1A`
          : meta.background === "accent"
            ? colors.accentSoft
            : colors.raised;
  return (
    <View
      accessibilityLabel={meta.label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 12,
        backgroundColor,
      }}
    >
      <View
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          backgroundColor: colors[meta.tone],
        }}
      />
      <T variant="caption" tone={meta.tone}>
        {meta.label}
      </T>
    </View>
  );
}

type ChoiceOption<Value extends string | number> = {
  value: Value;
  label: string;
  detail?: string;
  disabled?: boolean;
};

function ChoiceField<Value extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: Value;
  options: ChoiceOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <View style={{ gap: 7 }}>
      <T variant="label">{label}</T>
      <Tap
        label={`Choose ${label}`}
        disabled={disabled}
        expanded={open}
        onPress={() => setOpen((current) => !current)}
        style={{
          ...styles.spread,
          paddingHorizontal: 14,
          paddingVertical: 11,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: open ? colors.accent : colors.line,
          backgroundColor: colors.surface,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label">{selected?.label ?? "Choose an option"}</T>
          {selected?.detail && (
            <T variant="caption" tone="secondary">
              {selected.detail}
            </T>
          )}
        </View>
        <Icon
          name={open ? "chevron.up" : "chevron.down"}
          size={16}
          color={colors.secondary}
        />
      </Tap>
      {open && (
        <View
          style={{
            gap: 4,
            padding: 6,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.raised,
          }}
        >
          {options.map((option) => (
            <Tap
              key={String(option.value)}
              label={option.label}
              selected={option.value === value}
              disabled={option.disabled}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
              style={{
                ...styles.spread,
                paddingHorizontal: 10,
                paddingVertical: 9,
                borderRadius: 13,
                backgroundColor:
                  option.value === value ? colors.surface : undefined,
              }}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="label">{option.label}</T>
                {option.detail && (
                  <T variant="caption" tone="secondary">
                    {option.detail}
                  </T>
                )}
              </View>
              {option.value === value && (
                <Icon name="checkmark" size={17} color={colors.accent} />
              )}
            </Tap>
          ))}
        </View>
      )}
    </View>
  );
}

async function releaseCoordinatorForMode(
  coordinator: Thread | undefined,
  current: "ordinary" | "dedicated",
  next: "ordinary" | "dedicated",
  force = false,
) {
  if (current === next && !force) return;
  if (!coordinator) return;
  if (
    coordinator.status === "running" ||
    coordinator.status === "awaiting-approval"
  ) {
    throw new Error(
      "Finish or stop the coordinator's current turn before changing collaboration mode or policy.",
    );
  }
  if (coordinator.status === "idle" && coordinator.provider_session_id)
    await rpc("threads.release", { thread_id: coordinator.id });
}

export default function CollaborationScreen() {
  const { threadId, view } = useLocalSearchParams<{ threadId: string; view?: WorkspaceTab }>();
  const app = useApp();
  const thread = app.threads.find((item) => item.id === threadId);
  const projectThreads = app.threads.filter(
    (item) => item.project_id === thread?.project_id,
  );
  const providers = app.providers.filter((item) => item.available);
  const [detail, setDetail] = useState<CollaborationGroupDetail | null>(null);
  const [groupChoices, setGroupChoices] = useState<CollaborationGroupDetail[]>([]);
  const [messages, setMessages] = useState<CollaborationMessage[]>([]);
  const [entries, setEntries] = useState<ContextEntry[]>([]);
  const [assignments, setAssignments] = useState<CollaborationAssignment[]>([]);
  const [assignmentCursor, setAssignmentCursor] = useState<string | null>(null);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [contextCursor, setContextCursor] = useState<string | null>(null);
  const [olderWindow, setOlderWindow] = useState({
    assignments: false,
    messages: false,
    context: false,
  });
  const [tab, setTab] = useState<WorkspaceTab>(view === "context" || view === "results" || view === "messages" ? view : "work");
  useEffect(() => {
    if (view === "context" || view === "results" || view === "messages" || view === "work") setTab(view);
  }, [view]);
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [contextEditing, setContextEditing] = useState<ContextEntry | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadGeneration = useRef(0);
  const selectedGroupId = useRef<string | null>(null);
  const loadedLimits = useRef({ assignments: 50, messages: 50, context: 50 });
  const starterRef = useRef<ReturnType<typeof createAgentStarter> | null>(null);
  const starter =
    starterRef.current ?? (starterRef.current = createAgentStarter(rpc, randomUUID));

  const load = useCallback(async () => {
    if (!thread) return;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      let match: CollaborationGroupDetail | null = null;
      let newestMatch: CollaborationGroupDetail | null = null;
      let newestOpen: CollaborationGroupDetail | null = null;
      let selectedMatch: CollaborationGroupDetail | null = null;
      const matches: CollaborationGroupDetail[] = [];
      let cursor: string | undefined;
      do {
        const listed = await rpc("collaboration.groups.list", {
          project_id: thread.project_id,
          include_stopped: true,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const group of listed.groups) {
          if (generation !== loadGeneration.current) return;
          const candidate = await rpc("collaboration.groups.get", {
            group_id: group.id,
          });
          if (
            candidate.members.some((member) => member.thread_id === threadId) ||
            group.coordinator_thread_id === threadId
          ) {
            matches.push(candidate);
            newestMatch = candidate;
            if (group.status !== "completed") newestOpen = candidate;
            if (group.id === selectedGroupId.current) selectedMatch = candidate;
          }
        }
        if (generation !== loadGeneration.current) break;
        cursor = listed.next_cursor ?? undefined;
      } while (cursor);
      match = selectedMatch ?? newestOpen ?? newestMatch;
      if (generation !== loadGeneration.current) return;
      setGroupChoices(matches.reverse());
      setDetail(match);
      setOlderWindow({ assignments: false, messages: false, context: false });
      if (match) {
        const [assignmentPage, messagePage, contextPage] = await Promise.all([
          rpc("collaboration.assignments.list", {
            group_id: match.group.id,
            include_finished: true,
            limit: loadedLimits.current.assignments,
          }),
          rpc("collaboration.messages.list", {
            group_id: match.group.id,
            limit: loadedLimits.current.messages,
          }),
          rpc("collaboration.context.list", {
            group_id: match.group.id,
            limit: loadedLimits.current.context,
          }),
        ]);
        if (generation !== loadGeneration.current) return;
        setAssignments(assignmentPage.assignments);
        setAssignmentCursor(assignmentPage.next_cursor ?? null);
        setMessages(messagePage.messages);
        setMessageCursor(messagePage.next_cursor ?? null);
        setEntries(contextPage.entries);
        setContextCursor(contextPage.next_cursor ?? null);
      } else {
        setMessages([]);
        setEntries([]);
        setAssignments([]);
        setAssignmentCursor(null);
        setMessageCursor(null);
        setContextCursor(null);
      }
    } catch (cause) {
      if (generation === loadGeneration.current) setError(errorText(cause));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [thread?.id, thread?.project_id, threadId]);

  useEffect(() => {
    void load();
    const generation = loadGeneration.current;
    return () => {
      if (loadGeneration.current === generation) loadGeneration.current++;
    };
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeCollaboration((event: ThreadEvent | null) => {
      if (shouldReloadCollaboration(event, detail?.group.id)) {
        clearTimeout(timer);
        timer = setTimeout(() => void load(), event === null ? 0 : 80);
      }
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [detail?.group.id, load]);

  async function run(
    work: () => Promise<unknown>,
    onError?: (message: string) => void,
  ) {
    setBusy(true);
    setError("");
    try {
      await work();
      await load();
      return true;
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      onError?.(message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function more(kind: "assignments" | "messages" | "context") {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "assignments" && assignmentCursor) {
        const page = await rpc("collaboration.assignments.list", {
          group_id: detail.group.id,
          include_finished: true,
          cursor: assignmentCursor,
          limit: 50,
        });
        setAssignments((current) => {
          const combined = [
            ...current,
            ...page.assignments.filter(
              (item) => !current.some((existing) => existing.id === item.id),
            ),
          ];
          if (combined.length > 200)
            setOlderWindow((value) => ({ ...value, assignments: true }));
          return combined.slice(-200);
        });
        loadedLimits.current.assignments = Math.min(
          200,
          loadedLimits.current.assignments + page.assignments.length,
        );
        setAssignmentCursor(page.next_cursor ?? null);
      } else if (kind === "messages" && messageCursor) {
        const page = await rpc("collaboration.messages.list", {
          group_id: detail.group.id,
          cursor: messageCursor,
          limit: 50,
        });
        setMessages((current) => {
          const combined = [
            ...current,
            ...page.messages.filter(
              (item) => !current.some((existing) => existing.id === item.id),
            ),
          ];
          if (combined.length > 200)
            setOlderWindow((value) => ({ ...value, messages: true }));
          return combined.slice(-200);
        });
        loadedLimits.current.messages = Math.min(
          200,
          loadedLimits.current.messages + page.messages.length,
        );
        setMessageCursor(page.next_cursor ?? null);
      } else if (kind === "context" && contextCursor) {
        const page = await rpc("collaboration.context.list", {
          group_id: detail.group.id,
          cursor: contextCursor,
          limit: 50,
        });
        setEntries((current) => {
          const combined = [
            ...current,
            ...page.entries.filter(
              (item) => !current.some((existing) => existing.id === item.id),
            ),
          ];
          if (combined.length > 200)
            setOlderWindow((value) => ({ ...value, context: true }));
          return combined.slice(-200);
        });
        loadedLimits.current.context = Math.min(
          200,
          loadedLimits.current.context + page.entries.length,
        );
        setContextCursor(page.next_cursor ?? null);
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  function openSheet(kind: SheetKind) {
    setSheet(kind);
  }
  function closeSheet() {
    setSheet(null);
    setContextEditing(null);
  }

  const activeAssignments = useMemo(
    () => assignments.filter((assignment) => !finished.has(assignment.status)),
    [assignments],
  );
  const recentAssignments = useMemo(
    () => assignments.filter((assignment) => finished.has(assignment.status)),
    [assignments],
  );
  const coordinator = detail
    ? projectThreads.find((item) => item.id === detail.group.coordinator_thread_id)
    : thread;

  return (
    <>
      <Page>
        <Stack.Screen options={{ title: thread?.coordinator_project_id ? "Project coordinator" : "Agents" }} />
        <ErrorBanner error={error} onRetry={() => void load()} />
        {!thread ? (
          <T tone="secondary">This thread is no longer available.</T>
        ) : loading && !detail ? (
          <T tone="secondary">Loading agents…</T>
        ) : !detail ? (
          <CreateLanding
            thread={thread}
            onStart={() => openSheet("setup")}
          />
        ) : (
          <>
            <ObjectiveSummary
              detail={detail}
              assignments={assignments}
              onManage={() => openSheet("manage")}
            />
            <WorkspaceSwitcher
              tab={tab}
              onChange={setTab}
              coordinator={!!thread.coordinator_project_id}
              counts={{
                work: activeAssignments.length + recentAssignments.length,
                messages: messages.length,
                context: entries.length,
                results: recentAssignments.length,
              }}
            />
            <View
              pointerEvents={tab === "work" ? "auto" : "none"}
              style={{ display: tab === "work" ? "flex" : "none" }}
            >
              <WorkPanel
                detail={detail}
                activeAssignments={activeAssignments}
                recentAssignments={recentAssignments}
                assignmentsCursor={assignmentCursor}
                olderWindow={olderWindow.assignments}
                threads={projectThreads}
                providers={app.providers}
                currentThreadId={threadId}
                busy={busy}
                onCreate={() => {
                  if (detail.group.status === "completed") {
                    selectedGroupId.current = null;
                  }
                  openSheet("assignment");
                }}
                onResume={() =>
                  void run(() => groupControl(detail.group.id, "resume"))
                }
                onManagePeople={() => openSheet("participants")}
                onMore={() => void more("assignments")}
                onReturnLatest={() => void load()}
                onCancel={(assignmentId) =>
                  void run(() =>
                    rpc("collaboration.assignments.cancel", {
                      operation_id: randomUUID(),
                      assignment_id: assignmentId,
                      reason: "Cancelled by the user",
                    }),
                  )
                }
                coordinator={!!thread.coordinator_project_id}
              />
            </View>
            {tab === "results" && (
              <View style={{ gap: 20 }}>
                <T variant="heading">Results</T>
                {recentAssignments.length ? recentAssignments.map((assignment) => (
                  <AssignmentRow key={assignment.id} assignment={assignment} threads={projectThreads}
                    providers={app.providers} busy={busy} onCancel={() => undefined}
                    onOpenThread={(id) => router.push({ pathname: "/thread/[id]", params: { id } })} />
                )) : <T tone="secondary">Worker summaries, checks, and changed files appear here when tasks finish. Describe the work in the coordinator conversation to start.</T>}
                {assignmentCursor && <Button secondary busy={busy} onPress={() => void more("assignments")}>Load earlier results</Button>}
                {olderWindow.assignments && <Button secondary busy={busy} onPress={() => void load()}>Return to latest results</Button>}
              </View>
            )}
            <View
              pointerEvents={tab === "messages" ? "auto" : "none"}
              style={{ display: tab === "messages" ? "flex" : "none" }}
            >
              <MessagesPanel
                detail={detail}
                currentThreadId={threadId}
                threads={projectThreads}
                messages={messages}
                onCompose={() => openSheet("message")}
                onMore={() => void more("messages")}
                onReturnLatest={() => void load()}
                hasMore={Boolean(messageCursor)}
                olderWindow={olderWindow.messages}
              />
            </View>
            <View
              pointerEvents={tab === "context" ? "auto" : "none"}
              style={{ display: tab === "context" ? "flex" : "none" }}
            >
              <ContextPanel
                entries={entries}
                busy={busy}
                onAdd={() => {
                  setContextEditing(null);
                  openSheet("context");
                }}
                onEdit={(entry) => {
                  setContextEditing(entry);
                  openSheet("context");
                }}
                onMore={() => void more("context")}
                onReturnLatest={() => void load()}
                hasMore={Boolean(contextCursor)}
                olderWindow={olderWindow.context}
                projectKnowledge={!!thread.coordinator_project_id}
              />
            </View>
          </>
        )}
      </Page>

      {thread && !detail && (
        <StartAgentSheet
          thread={thread}
          starter={starter}
          providers={providers}
          busy={busy}
          run={run}
          visible={sheet === "setup"}
          onClose={closeSheet}
        />
      )}
      {detail && (
        <>
          <ObjectiveSheet
            key={`objective-${detail.group.id}`}
            detail={detail}
            busy={busy}
            run={run}
            visible={sheet === "objective"}
            onClose={closeSheet}
          />
          <ManageGroupSheet
            detail={detail}
            groups={groupChoices}
            persistentCoordinator={Boolean(coordinator?.coordinator_project_id)}
            busy={busy}
            run={run}
            visible={sheet === "manage"}
            onClose={closeSheet}
            onOpen={openSheet}
            onSelect={(groupId) => {
              selectedGroupId.current = groupId;
              closeSheet();
              void load();
            }}
          />
          <GroupSettingsSheet
            key={`settings-${detail.group.id}`}
            detail={detail}
            coordinator={coordinator}
            providers={app.providers}
            busy={busy}
            run={run}
            visible={sheet === "settings"}
            onClose={closeSheet}
          />
          <ParticipantsSheet
            key={`participants-${detail.group.id}`}
            detail={detail}
            currentThreadId={threadId}
            threads={projectThreads}
            busy={busy}
            run={run}
            visible={sheet === "participants"}
            onClose={closeSheet}
          />
          <StartAgentSheet
            key={`assignment-${detail.group.id}`}
            thread={thread!}
            group={detail.group}
            starter={starter}
            providers={providers.filter(
              (provider) =>
                !detail.group.policy.allowed_providers.length ||
                detail.group.policy.allowed_providers.includes(provider.kind),
            )}
            busy={busy}
            run={run}
            visible={sheet === "assignment"}
            onClose={closeSheet}
          />
          <MessageSheet
            key={`message-${detail.group.id}`}
            detail={detail}
            currentThreadId={threadId}
            threads={projectThreads}
            busy={busy}
            run={run}
            visible={sheet === "message"}
            onClose={closeSheet}
          />
          <ContextEditorSheet
            groupId={detail.group.id}
            entry={contextEditing}
            busy={busy}
            run={run}
            visible={sheet === "context"}
            onClose={closeSheet}
          />
        </>
      )}
    </>
  );
}

function CreateLanding({
  thread,
  onStart,
}: {
  thread: Thread;
  onStart: () => void;
}) {
  const { colors } = useTheme();
  const [explaining, setExplaining] = useState(false);
  return (
    <View style={{ paddingVertical: space.xxl, gap: 20 }}>
      <SurfaceCard style={{ padding: 22, gap: 15 }}>
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accentSoft,
          }}
        >
          <Icon name="person.2" size={24} color={colors.accent} />
        </View>
        <View style={{ gap: 6 }}>
          <T variant="title">No helper conversations yet</T>
          <T tone="secondary" style={{ maxWidth: 500 }}>
            Ask in the main conversation to delegate work. Kybern creates each
            helper as a real conversation with its own provider and workspace.
          </T>
        </View>
        <View style={[styles.line, { gap: 9 }]}>
          <ProviderMark kind={thread.provider.kind} size={20} />
          <T variant="caption" tone="secondary">
            Main thread
          </T>
        </View>
        <Button
          onPress={() =>
            router.dismissTo({
              pathname: "/thread/[id]",
              params: { id: thread.id },
            })
          }
        >
          Back to conversation
        </Button>
        <Button secondary icon="plus" onPress={onStart}>
          Start a helper manually
        </Button>
        <Tap
          label={explaining ? "Hide how agents work" : "How agents work"}
          expanded={explaining}
          onPress={() => setExplaining((value) => !value)}
          style={{ paddingHorizontal: 4 }}
        >
          <View style={[styles.spread, { minHeight: 44 }]}>
            <T variant="label" tone="accent">How agents work</T>
            <Icon name={explaining ? "chevron.up" : "chevron.down"} size={16} color={colors.accent} />
          </View>
        </Tap>
        {explaining && (
          <View style={{ gap: 8 }}>
            <T tone="secondary">
              You can open or message every helper. Helpers may use different
              providers and report their results here.
            </T>
            <T variant="caption" tone="secondary">
              Provider-native background tasks stay inside one conversation;
              helpers listed here are separate Kybern threads.
            </T>
            <T variant="caption" tone="secondary">
              Try: “Have Codex review this change and report back.”
            </T>
          </View>
        )}
      </SurfaceCard>
    </View>
  );
}

function ObjectiveSummary({
  detail,
  assignments,
  onManage,
}: {
  detail: CollaborationGroupDetail;
  assignments: CollaborationAssignment[];
  onManage: () => void;
}) {
  const { colors } = useTheme();
  const [explaining, setExplaining] = useState(false);
  const active = assignments.filter((assignment) => !finished.has(assignment.status));
  const completed = assignments.filter((assignment) => assignment.status === "completed");
  const group = detail.group;
  return (
    <SurfaceCard style={{ padding: 14, gap: 8 }}>
      <View style={[styles.spread, { alignItems: "flex-start" }]}>
        <View style={[styles.line, { flex: 1, alignItems: "flex-start" }]}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 14,
              backgroundColor: colors.accentSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="person.2" size={20} color={colors.accent} />
          </View>
          <View style={{ flex: 1, gap: 5 }}>
            <T variant="heading" accessibilityRole="header">
              Agents
            </T>
            <View style={[styles.line, { flexWrap: "wrap", gap: 8 }]}>
              <StatusPill status={group.status} />
              <T variant="caption" tone="secondary">
                {active.length} active · {completed.length} complete
              </T>
            </View>
          </View>
        </View>
        <IconButton
          name="ellipsis"
          label="Open agent settings"
          onPress={onManage}
        />
      </View>
      <View style={[styles.line, { flexWrap: "wrap", gap: 8 }]}>
        <T variant="caption" tone="secondary">
          Main thread coordinates
        </T>
        <T variant="caption" tone="secondary">
          {Math.max(0, detail.members.filter((member) => member.active).length - 1)} helpers
        </T>
      </View>
      <Tap
        label={explaining ? "Hide how agents work" : "How agents work"}
        expanded={explaining}
        onPress={() => setExplaining((value) => !value)}
        style={{ paddingHorizontal: 2 }}
      >
        <View style={[styles.spread, { minHeight: 44 }]}>
          <T variant="caption" tone="accent">How agents work</T>
          <Icon name={explaining ? "chevron.up" : "chevron.down"} size={15} color={colors.accent} />
        </View>
      </Tap>
      {explaining && (
        <T variant="caption" tone="secondary">
          Each helper is a separate Kybern thread with its own provider,
          workspace, history, and message composer. Provider-native background
          tasks stay inside their original conversation.
        </T>
      )}
    </SurfaceCard>
  );
}

function WorkspaceSwitcher({
  tab,
  onChange,
  counts,
  coordinator,
}: {
  tab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  counts: Record<WorkspaceTab, number>;
  coordinator: boolean;
}) {
  const { colors } = useTheme();
  const tabs: { value: WorkspaceTab; label: string }[] = coordinator ? [
    { value: "work", label: "Workers" },
    { value: "context", label: "Knowledge" },
    { value: "results", label: "Results" },
  ] : [
    { value: "work", label: "Agents" },
    { value: "messages", label: "Messages" },
    { value: "context", label: "Shared notes" },
  ];
  return (
    <View style={{ marginVertical: 20, gap: 8 }}>
      <T variant="caption" tone="secondary">
        View
      </T>
      <View
        style={{
          flexDirection: "row",
          gap: 4,
          padding: 4,
          borderRadius: 18,
          backgroundColor: colors.raised,
        }}
      >
        {tabs.map((item) => {
          const selected = tab === item.value;
          return (
            <Tap
              key={item.value}
              label={`Show ${item.label}`}
              selected={selected}
              onPress={() => onChange(item.value)}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 14,
                paddingHorizontal: 8,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: selected ? colors.surface : undefined,
                boxShadow: selected ? "0 2px 8px #00000014" : undefined,
              }}
            >
              <T variant="caption" tone={selected ? "ink" : "secondary"}>
                {item.label}
                {counts[item.value] ? ` · ${counts[item.value]}` : ""}
              </T>
            </Tap>
          );
        })}
      </View>
      {coordinator && (
        <Tap
          label="Show agent messages"
          selected={tab === "messages"}
          onPress={() => onChange("messages")}
          style={[styles.line, { alignSelf: "flex-end", minHeight: 44, paddingHorizontal: 8, gap: 6 }]}
        >
          <Icon name="text.bubble" size={15} color={colors.secondary} />
          <T variant="caption" tone={tab === "messages" ? "accent" : "secondary"}>Agent messages</T>
        </Tap>
      )}
    </View>
  );
}

function ObjectiveBrief({
  detail,
  onEdit,
}: {
  detail: CollaborationGroupDetail;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const group = detail.group;
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.spread}>
        <T variant="label">Objective</T>
        <Tap label="Edit objective" onPress={onEdit}>
          <T variant="caption" tone="accent">Edit</T>
        </Tap>
      </View>
      <Tap
        label={expanded ? "Hide full objective" : "Read full objective"}
        expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={{ paddingVertical: 4 }}
      >
        <View style={{ flex: 1, gap: 7 }}>
          <T selectable numberOfLines={expanded ? undefined : 3}>
            {group.objective}
          </T>
          {expanded && group.success_criteria.length > 0 && (
            <View style={{ gap: 5 }}>
              <T variant="caption" tone="secondary">Success criteria</T>
              {group.success_criteria.map((criterion) => (
                <T key={criterion} variant="caption" tone="secondary" selectable>
                  • {criterion}
                </T>
              ))}
            </View>
          )}
          <T variant="caption" tone="secondary">
            {expanded ? "Hide objective" : "Read full objective"}
          </T>
        </View>
      </Tap>
    </View>
  );
}

function WorkPanel({
  detail,
  activeAssignments,
  recentAssignments,
  assignmentsCursor,
  olderWindow,
  threads,
  providers,
  currentThreadId,
  busy,
  onCreate,
  onResume,
  onManagePeople,
  onMore,
  onReturnLatest,
  onCancel,
  coordinator = false,
}: {
  detail: CollaborationGroupDetail;
  activeAssignments: CollaborationAssignment[];
  recentAssignments: CollaborationAssignment[];
  assignmentsCursor: string | null;
  olderWindow: boolean;
  threads: Thread[];
  providers: ProviderStatus[];
  currentThreadId: string;
  busy: boolean;
  onCreate: () => void;
  onResume: () => void;
  onManagePeople: () => void;
  onMore: () => void;
  onReturnLatest: () => void;
  onCancel: (assignmentId: string) => void;
  coordinator?: boolean;
}) {
  const active = detail.group.status === "active";
  const completed = detail.group.status === "completed";
  return (
    <View style={{ gap: 24, paddingBottom: 10 }}>
      <View style={[styles.spread, { alignItems: "flex-end" }]}>
        <View style={{ flex: 1, gap: 5 }}>
          <T variant="heading">{coordinator ? "Workers" : "Agents"}</T>
          <T variant="caption" tone="secondary">
            {activeAssignments.length} active · {recentAssignments.length} recent
          </T>
        </View>
        {active ? (
          <Button secondary icon="plus" onPress={onCreate}>Start agent</Button>
        ) : completed ? (
          <Button secondary icon="plus" onPress={onCreate}>Start agent</Button>
        ) : (
          <Button secondary onPress={onResume}>Resume agents</Button>
        )}
      </View>
      {activeAssignments.length ? (
        <SectionCard title="Active agents">
          {activeAssignments.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              threads={threads}
              providers={providers}
              busy={busy}
              onOpenThread={(threadId) =>
                router.push({ pathname: "/thread/[id]", params: { id: threadId } })
              }
              onCancel={() => onCancel(assignment.id)}
            />
          ))}
        </SectionCard>
      ) : !recentAssignments.length && !completed ? (
        <SectionCard title="Active agents">
          <T variant="caption" tone="secondary">
            No helper agents yet. Start one here, or ask the main agent to
            start a helper from the conversation.
          </T>
        </SectionCard>
      ) : null}
      {!coordinator && !!recentAssignments.length && (
        <SectionCard title="Recent results">
          {recentAssignments.map((assignment) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              threads={threads}
              providers={providers}
              busy={busy}
              onOpenThread={(threadId) =>
                router.push({ pathname: "/thread/[id]", params: { id: threadId } })
              }
              onCancel={() => undefined}
            />
          ))}
        </SectionCard>
      )}
      <PeopleRoster
        detail={detail}
        threads={threads}
        currentThreadId={currentThreadId}
        onManage={onManagePeople}
      />
      {assignmentsCursor && (
        <Button secondary busy={busy} onPress={onMore}>
          Load earlier work
        </Button>
      )}
      {olderWindow && (
        <Button secondary busy={busy} onPress={onReturnLatest}>
          Return to latest work
        </Button>
      )}
    </View>
  );
}

function AssignmentRow({
  assignment,
  threads,
  providers,
  busy,
  onOpenThread,
  onCancel,
}: {
  assignment: CollaborationAssignment;
  threads: Thread[];
  providers: ProviderStatus[];
  busy: boolean;
  onOpenThread: (threadId: string) => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const owner = assignment.owner_thread_id
    ? threads.find((thread) => thread.id === assignment.owner_thread_id)
    : undefined;
  const providerKind = owner?.provider.kind ?? assignment.requested_child?.provider.kind;
  const provider = providerKind
    ? providers.find((item) => item.kind === providerKind)
    : undefined;
  const child = assignment.requested_child;
  const providerLabel = provider?.display_name ?? providerKind ?? "Agent";
  const model = owner?.model ?? child?.model;
  const effort = owner?.effort ?? child?.effort;
  const meta = [
    providerLabel,
    model,
    effort ? `${effort} effort` : "",
    assignmentKindLabels[assignment.kind],
  ]
    .filter(Boolean)
    .join(" · ");
  const preview =
    assignment.result?.summary ||
    assignment.uncertainty ||
    (assignment.status === "pending" && child ? "Preparing child thread" : undefined);
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Tap
        label={`${assignment.title}, ${statusMeta(assignment.status).label}. ${
          expanded ? "Hide details" : "Show details"
        }`}
        selected={expanded}
        expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
        style={{ paddingHorizontal: 10, paddingVertical: 8 }}
      >
        <View style={[styles.line, { alignItems: "flex-start", gap: 10 }]}>
          <View style={{ paddingTop: 4 }}>
            <StatusDot status={assignment.status} />
          </View>
          {providerKind && <ProviderMark kind={providerKind} size={20} />}
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="label" numberOfLines={expanded ? undefined : 2}>{assignment.title}</T>
            <T variant="caption" tone="secondary">
              {meta} · {statusMeta(assignment.status).label}
            </T>
            {!expanded && preview && (
              <T variant="caption" tone="secondary" numberOfLines={2}>
                {preview}
              </T>
            )}
          </View>
          <Icon
            name={expanded ? "chevron.up" : "chevron.down"}
            size={16}
            color={colors.secondary}
          />
        </View>
      </Tap>
      {expanded && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 13 }}>
          <View style={{ gap: 5 }}>
            <T variant="caption" tone="secondary">
              Instructions
            </T>
            <T selectable>{assignment.instructions}</T>
          </View>
          {assignment.base_revision && (
            <View style={{ gap: 4 }}>
              <T variant="caption" tone="secondary">
                Base revision
              </T>
              <T variant="mono" selectable>
                {assignment.base_revision}
              </T>
            </View>
          )}
          {assignment.uncertainty && (
            <View style={{ gap: 4 }}>
              <T variant="caption" tone="warning">
                Needs attention
              </T>
              <T selectable>{assignment.uncertainty}</T>
            </View>
          )}
          {assignment.result && <AssignmentResultDetails result={assignment.result} />}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {assignment.owner_thread_id && (
              <Button
                secondary
                icon="text.bubble"
                onPress={() => onOpenThread(assignment.owner_thread_id!)}
              >
                Open thread
              </Button>
            )}
            {assignment.owner_thread_id && (
              <Button
                secondary
                icon="text.bubble"
                onPress={() => onOpenThread(assignment.owner_thread_id!)}
              >
                Message
              </Button>
            )}
            {!finished.has(assignment.status) && (
              <Button secondary busy={busy} onPress={onCancel}>
                Cancel assignment
              </Button>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function StatusDot({ status }: { status: string }) {
  const { colors } = useTheme();
  const meta = statusMeta(status);
  return (
    <View
      style={{
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: colors[meta.tone],
      }}
    />
  );
}

function AssignmentResultDetails({ result }: { result: AssignmentResult }) {
  return (
    <View style={{ gap: 11 }}>
      <T variant="caption" tone="secondary">
        Result · {sentenceCase(result.outcome)}
      </T>
      <T selectable>{result.summary}</T>
      <DetailList title="Changes" items={result.changes} />
      <DetailList title="Checks" items={result.checks} />
      <DetailList title="Artifacts" items={result.artifacts} />
      <DetailList title="Unresolved" items={result.unresolved} tone="warning" />
    </View>
  );
}

function DetailList({
  title,
  items,
  tone = "secondary",
}: {
  title: string;
  items: string[];
  tone?: StatusTone;
}) {
  if (!items.length) return null;
  return (
    <View style={{ gap: 4 }}>
      <T variant="caption" tone="secondary">
        {title}
      </T>
      {items.map((item, index) => (
        <T key={`${title}-${index}`} tone={tone} selectable>
          • {item}
        </T>
      ))}
    </View>
  );
}

function PeopleRoster({
  detail,
  threads,
  currentThreadId,
  onManage,
}: {
  detail: CollaborationGroupDetail;
  threads: Thread[];
  currentThreadId: string;
  onManage: () => void;
}) {
  return (
    <SectionCard
      title="Threads"
      action={
        <Tap label="Manage people" onPress={onManage}>
          <T variant="caption" tone="accent">
            Manage
          </T>
        </Tap>
      }
    >
      {detail.members.map((member) => {
        const thread = threads.find((item) => item.id === member.thread_id);
        const isCurrent = member.thread_id === currentThreadId;
        return (
          <Tap
            key={member.thread_id}
            label={`Open ${member.role === "coordinator" ? "main thread" : thread?.title || "agent thread"}`}
            onPress={() =>
              router.push({ pathname: "/thread/[id]", params: { id: member.thread_id } })
            }
            style={{ paddingHorizontal: 8, paddingVertical: 8 }}
          >
            <View style={[styles.line, { alignItems: "flex-start" }]}>
              {thread && <ProviderMark kind={thread.provider.kind} size={20} />}
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="label">
                  {member.role === "coordinator"
                    ? "Main thread"
                    : thread?.title || member.thread_id.slice(0, 8)}
                </T>
                <T variant="caption" tone="secondary">
                  {member.role === "coordinator"
                    ? thread?.title || "Coordinator"
                    : roleLabels[member.role as Exclude<GroupMemberRole, "coordinator">]}
                  {isCurrent ? " · This thread" : ""}
                  {member.active ? " · Active" : " · Reference"}
                </T>
              </View>
              <Icon name="chevron.right" size={14} color="#777777" />
            </View>
          </Tap>
        );
      })}
      {!detail.members.length && (
        <T variant="caption" tone="secondary">
          No helper threads yet.
        </T>
      )}
    </SectionCard>
  );
}

function MessagesPanel({
  detail,
  currentThreadId,
  threads,
  messages,
  onCompose,
  onMore,
  onReturnLatest,
  hasMore,
  olderWindow,
}: {
  detail: CollaborationGroupDetail;
  currentThreadId: string;
  threads: Thread[];
  messages: CollaborationMessage[];
  onCompose: () => void;
  onMore: () => void;
  onReturnLatest: () => void;
  hasMore: boolean;
  olderWindow: boolean;
}) {
  return (
    <View style={{ gap: 18, paddingBottom: 10 }}>
      <View style={[styles.spread, { alignItems: "flex-end" }]}>
        <View style={{ flex: 1, gap: 5 }}>
          <T variant="heading">Messages</T>
          <T variant="caption" tone="secondary">
            Informational notes shared between agent threads.
          </T>
        </View>
        <Button secondary icon="text.bubble" onPress={onCompose}>
          Save note
        </Button>
      </View>
      <SectionCard title="Recent messages">
        {[...messages].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            currentThreadId={currentThreadId}
            threads={threads}
          />
        ))}
        {!messages.length && (
          <T variant="caption" tone="secondary">
            No notes yet. Messages that wake an agent belong in that agent’s
            thread.
          </T>
        )}
      </SectionCard>
      {hasMore && (
        <Button secondary onPress={onMore}>
          Load earlier messages
        </Button>
      )}
      {olderWindow && (
        <Button secondary onPress={onReturnLatest}>
          Return to latest messages
        </Button>
      )}
      <T variant="caption" tone="muted" selectable>
        This group has {Math.max(0, detail.members.filter((member) => member.active).length - 1)} active
        helpers.
      </T>
    </View>
  );
}

function MessageRow({
  message,
  currentThreadId,
  threads,
}: {
  message: CollaborationMessage;
  currentThreadId: string;
  threads: Thread[];
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const from = message.from_thread_id
    ? threads.find((thread) => thread.id === message.from_thread_id)
    : undefined;
  const to = threads.find((thread) => thread.id === message.to_thread_id);
  const name = (thread: Thread | undefined, id?: string | null) =>
    thread?.title ||
    (id === currentThreadId ? "This thread" : id ? id.slice(0, 8) : "You");
  const purpose: Record<CollaborationMessage["purpose"], string> = {
    progress: "Progress note",
    question: "Question",
    reply: "Reply",
    change_request: "Change request",
    result: "Result",
    failure: "Failure",
    redirect: "Redirect",
  };
  const delivery: Record<CollaborationMessage["state"], string> = {
    persisted: "Saved",
    queued: "Queued",
    submitted: "Sent",
    answered: "Answered",
    failed: "Failed",
    cancelled: "Cancelled",
    uncertain: "Delivery uncertain",
  };
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Tap
        label={`${purpose[message.purpose]} from ${name(from, message.from_thread_id)}. ${
          expanded ? "Hide message" : "Read message"
        }`}
        selected={expanded}
        expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
        style={{ paddingHorizontal: 10, paddingVertical: 8 }}
      >
        <View style={[styles.line, { alignItems: "flex-start", gap: 9 }]}>
          <View style={[styles.line, { gap: 3, paddingTop: 2 }]}>
            {from && <ProviderMark kind={from.provider.kind} size={17} />}
            <Icon name="arrow.right" size={12} color={colors.muted} />
            {to && <ProviderMark kind={to.provider.kind} size={17} />}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="label" numberOfLines={1}>
              {name(from, message.from_thread_id)} → {name(to, message.to_thread_id)}
            </T>
            <T variant="caption" tone="secondary">
              {purpose[message.purpose]} · {delivery[message.state]} · {formatDateTime(message.created_at)}
            </T>
            {!expanded && (
              <T variant="caption" tone="secondary" numberOfLines={2}>
                {message.body}
              </T>
            )}
          </View>
          <Icon
            name={expanded ? "chevron.up" : "chevron.down"}
            size={16}
            color={colors.secondary}
          />
        </View>
      </Tap>
      {expanded && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 10 }}>
          <T variant="caption" tone="secondary" selectable>
            {name(from, message.from_thread_id)} → {name(to, message.to_thread_id)}
          </T>
          <T selectable>{message.body}</T>
          {message.from_thread_id && !from && (
            <T variant="mono" selectable>
              Sender thread: {message.from_thread_id}
            </T>
          )}
          {message.purpose === "progress" && (
            <T variant="caption" tone="secondary">
              The recipient was not woken by this progress note.
            </T>
          )}
        </View>
      )}
    </View>
  );
}

function ContextPanel({
  entries,
  busy,
  onAdd,
  onEdit,
  onMore,
  onReturnLatest,
  hasMore,
  olderWindow,
  projectKnowledge,
}: {
  entries: ContextEntry[];
  busy: boolean;
  onAdd: () => void;
  onEdit: (entry: ContextEntry) => void;
  onMore: () => void;
  onReturnLatest: () => void;
  hasMore: boolean;
  olderWindow: boolean;
  projectKnowledge: boolean;
}) {
  const [history, setHistory] = useState<Record<string, ContextEntry[]>>({});
  const [historyCursor, setHistoryCursor] = useState<Record<string, number | null>>({});
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<Record<string, string>>({});
  const [olderHistory, setOlderHistory] = useState<Record<string, boolean>>({});
  const plans = entries.filter((entry) => entry.kind === "plan");
  const instructions = entries.filter(
    (entry) => entry.kind !== "plan" && (entry.user_authored || entry.kind === "instruction"),
  );
  const observations = entries.filter((entry) => !plans.includes(entry) && !instructions.includes(entry));
  async function fetchHistory(entry: ContextEntry, more = false) {
    setHistoryLoading(entry.id);
    setHistoryError((current) => ({ ...current, [entry.id]: "" }));
    try {
      const result = await rpc("collaboration.context.history", {
        entry_id: entry.id,
        ...(more ? { before_revision: historyCursor[entry.id] } : {}),
        limit: 20,
      });
      setHistory((current) => {
        const combined = more
          ? [...(current[entry.id] ?? []), ...result.revisions]
          : result.revisions;
        if (more && combined.length > 200)
          setOlderHistory((value) => ({ ...value, [entry.id]: true }));
        else if (!more)
          setOlderHistory((value) => ({ ...value, [entry.id]: false }));
        return { ...current, [entry.id]: combined.slice(-200) };
      });
      setHistoryCursor((current) => ({
        ...current,
        [entry.id]: result.next_before_revision ?? null,
      }));
    } catch (cause) {
      setHistoryError((current) => ({
        ...current,
        [entry.id]: `Couldn’t load revision history. Try again. ${errorText(cause)}`,
      }));
    } finally {
      setHistoryLoading(null);
    }
  }
  const section = (title: string, items: ContextEntry[]) => (
    <SectionCard title={title}>
      {items.map((entry) => (
        <ContextEntryRow
          key={entry.id}
          entry={entry}
          editable
          onEdit={() => onEdit(entry)}
          history={history[entry.id] ?? []}
          historyLoading={historyLoading === entry.id}
          historyCursor={historyCursor[entry.id]}
          olderHistory={Boolean(olderHistory[entry.id])}
          historyError={historyError[entry.id]}
          onHistory={(more) => void fetchHistory(entry, more)}
        />
      ))}
      {!items.length && (
        <T variant="caption" tone="secondary">
          No {title.toLowerCase()} yet.
        </T>
      )}
    </SectionCard>
  );
  return (
    <View style={{ gap: 18, paddingBottom: 10 }}>
      <View style={[styles.spread, { alignItems: "flex-end" }]}>
        <View style={{ flex: 1, gap: 5 }}>
          <T variant="heading">{projectKnowledge ? "Project knowledge" : "Shared notes"}</T>
          <T variant="caption" tone="secondary">
            {projectKnowledge
              ? "The coordinator autosaves its plan and useful findings here. Your instructions and corrections take authority; earlier revisions remain available."
              : "Instructions and knowledge every helper can read. Earlier versions remain available."}
          </T>
        </View>
        <Button secondary icon="plus" onPress={onAdd}>
          Add note
        </Button>
      </View>
      {entries.length ? (
        <>
          {plans.length > 0 && section("Current plan", plans)}
          {section("User instructions", instructions)}
          {observations.length > 0 && section("Agent observations", observations)}
        </>
      ) : (
        <SurfaceCard style={{ padding: 16, gap: 10 }}>
          <T variant="label">{projectKnowledge ? "No project knowledge yet" : "No shared notes yet"}</T>
          <T variant="caption" tone="secondary">
            {projectKnowledge
              ? "Add an instruction or correction now. The coordinator’s plan and autosaved findings will appear here as work progresses."
              : "Add an instruction, decision, or finding that every helper can use."}
          </T>
          <Button secondary icon="plus" onPress={onAdd}>
            Add note
          </Button>
        </SurfaceCard>
      )}
      {hasMore && (
        <Button secondary busy={busy} onPress={onMore}>
          Load earlier notes
        </Button>
      )}
      {olderWindow && (
        <Button secondary busy={busy} onPress={onReturnLatest}>
          Return to latest notes
        </Button>
      )}
    </View>
  );
}

function ContextEntryRow({
  entry,
  editable,
  onEdit,
  history,
  historyLoading,
  historyCursor,
  olderHistory,
  historyError,
  onHistory,
}: {
  entry: ContextEntry;
  editable: boolean;
  onEdit: () => void;
  history: ContextEntry[];
  historyLoading: boolean;
  historyCursor?: number | null;
  olderHistory: boolean;
  historyError?: string;
  onHistory: (more: boolean) => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Tap
        label={`${entry.key}. ${expanded ? "Hide context" : "Read context"}`}
        selected={expanded}
        expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
        style={{ paddingHorizontal: 10, paddingVertical: 8 }}
      >
        <View style={[styles.line, { alignItems: "flex-start", gap: 9 }]}>
          <Icon
            name={entry.user_authored ? "lock.shield" : "sparkles"}
            size={18}
            color={entry.user_authored ? colors.accent : colors.secondary}
          />
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="label">{entry.key}</T>
            <T variant="caption" tone="secondary">
              {contextKindLabels[entry.kind]} · revision {entry.revision}
            </T>
            {!expanded && (
              <T variant="caption" tone="secondary" numberOfLines={2}>
                {entry.body}
              </T>
            )}
          </View>
          <Icon
            name={expanded ? "chevron.up" : "chevron.down"}
            size={16}
            color={colors.secondary}
          />
        </View>
      </Tap>
      {expanded && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 11 }}>
          <T selectable>{entry.body}</T>
          {!!entry.source_refs.length && (
            <DetailList title="Sources" items={entry.source_refs} />
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              secondary
              busy={historyLoading}
              onPress={() => onHistory(false)}
            >
              View revision history
            </Button>
            {editable && (
              <Button secondary icon="pencil" onPress={onEdit}>
                {entry.user_authored ? "Edit context" : "Correct context"}
              </Button>
            )}
          </View>
          {!!history.length && (
            <View style={{ gap: 8 }}>
              <T variant="caption" tone="secondary">
                Revision history
              </T>
              {history.filter((revision) => revision.revision !== entry.revision).map((revision) => (
                <View
                  key={`${entry.id}-${revision.revision}`}
                  style={{ padding: 10, borderRadius: 14, backgroundColor: colors.surface }}
                >
                  <T variant="caption" tone="secondary">
                    Revision {revision.revision} · {revision.user_authored ? "User instruction" : "Agent observation"}
                  </T>
                  <T selectable>{revision.body}</T>
                </View>
              ))}
              {historyCursor != null && (
                <Button secondary busy={historyLoading} onPress={() => onHistory(true)}>
                  Load earlier revisions
                </Button>
              )}
              {olderHistory && (
                <Button secondary onPress={() => onHistory(false)}>
                  Return to current revision
                </Button>
              )}
            </View>
          )}
          {!!historyError && <ErrorBanner error={historyError} onRetry={() => onHistory(false)} />}
        </View>
      )}
    </View>
  );
}

function SheetHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <View
      style={[
        styles.spread,
        { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
      ]}
    >
      <T variant="heading" accessibilityRole="header">
        {title}
      </T>
      <IconButton name="xmark" label={`Close ${title}`} onPress={onClose} />
    </View>
  );
}

function CollaborationSheet({
  visible,
  title,
  onClose,
  children,
  heightFraction = 0.88,
}: PropsWithChildren<{
  visible: boolean;
  title: string;
  onClose: () => void;
  heightFraction?: number;
}>) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [visible]);
  const onClosed = useCallback(() => {
    if (!visible) setMounted(false);
  }, [visible]);
  const close = useCallback(() => {
    setOpen(false);
    onClose();
  }, [onClose]);

  if (!visible && Platform.OS !== "android") return null;
  if (Platform.OS !== "android") {
    return (
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : undefined}
        onRequestClose={onClose}
      >
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <SheetHeader title={title} onClose={onClose} />
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: 20,
              paddingBottom: insets.bottom + 28,
              gap: 18,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
        </View>
      </Modal>
    );
  }
  if (!mounted) return null;
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onRequestClose={close}
    >
      <View
        accessibilityViewIsModal
        style={{
          flex: 1,
          paddingTop: insets.top + 24,
          paddingHorizontal: 12,
          paddingBottom: Math.max(insets.bottom, 12),
          justifyContent: "flex-end",
        }}
      >
        <MorphingBackdrop open={open} onPress={close} label="Dismiss sheet" />
        <MorphingSurface
          open={open}
          onClosed={onClosed}
          slideFromBottom
          heightFraction={heightFraction}
          bottomInset={Math.max(insets.bottom, 12)}
          style={{ flex: 1, maxWidth: 760, width: "100%", alignSelf: "center" }}
        >
          <View style={{ flex: 1, backgroundColor: colors.surface }}>
            <SheetHeader title={title} onClose={close} />
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{
                paddingHorizontal: 20,
                paddingBottom: insets.bottom + 28,
                gap: 18,
              }}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          </View>
        </MorphingSurface>
      </View>
    </Modal>
  );
}

function ObjectiveSheet({
  detail,
  busy,
  run,
  visible,
  onClose,
}: {
  detail: CollaborationGroupDetail;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const [objective, setObjective] = useState(detail.group.objective);
  const [criteria, setCriteria] = useState(detail.group.success_criteria.join("\n"));
  const [baseline, setBaseline] = useState({
    revision: detail.group.revision,
    objective: detail.group.objective,
    criteria: detail.group.success_criteria.join("\n"),
  });
  useEffect(() => {
    if (visible) {
      const next = {
        revision: detail.group.revision,
        objective: detail.group.objective,
        criteria: detail.group.success_criteria.join("\n"),
      };
      setBaseline(next);
      setObjective(next.objective);
      setCriteria(next.criteria);
    }
  }, [visible, detail.group.id]);
  const changed =
    objective.trim() !== baseline.objective || criteria !== baseline.criteria;
  async function save() {
    if (!changed) return;
    const ok = await run(() =>
      rpc("collaboration.groups.update", {
        operation_id: randomUUID(),
        group_id: detail.group.id,
        expected_revision: baseline.revision,
        ...(objective.trim() !== baseline.objective
          ? { objective: objective.trim() }
          : {}),
        ...(criteria !== baseline.criteria
          ? { success_criteria: lineList(criteria) }
          : {}),
      }),
    );
    if (ok) onClose();
  }
  return (
    <CollaborationSheet visible={visible} title="Edit objective" onClose={onClose}>
      <View style={{ gap: 18 }}>
        <T tone="secondary">
          The objective is shared with every helper. Keep it stable and use
          agent tasks for focused instructions.
        </T>
        <Field
          label="Objective"
          value={objective}
          onChangeText={setObjective}
          multiline
          style={{ minHeight: 110 }}
        />
        <Field
          label="Success criteria"
          value={criteria}
          onChangeText={setCriteria}
          multiline
          style={{ minHeight: 110 }}
          placeholder="One criterion per line"
        />
        <Button
          busy={busy}
          disabled={!objective.trim() || !changed}
          onPress={() => void save()}
        >
          Save objective
        </Button>
      </View>
    </CollaborationSheet>
  );
}

function ManageGroupSheet({
  detail,
  groups,
  persistentCoordinator,
  busy,
  run,
  visible,
  onClose,
  onOpen,
  onSelect,
}: {
  detail: CollaborationGroupDetail;
  groups: CollaborationGroupDetail[];
  persistentCoordinator: boolean;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
  onOpen: (kind: SheetKind) => void;
  onSelect: (groupId: string) => void;
}) {
  async function control(action: "pause" | "stop" | "resume" | "complete") {
    const ok = await run(() => groupControl(detail.group.id, action));
    if (ok) onClose();
  }
  return (
    <CollaborationSheet
      visible={visible}
      title="Agent settings"
      onClose={onClose}
    >
      <View style={{ gap: 18 }}>
        <View style={{ gap: 6 }}>
          <T variant="label">Agent group status</T>
          <View style={[styles.line, { gap: 8 }]}>
            <StatusPill status={detail.group.status} />
            <T variant="caption" tone="secondary">
              {detail.group.coordinator_mode === "dedicated"
                ? "Dedicated coordinator"
                : "Ordinary coordinator"}
            </T>
          </View>
        </View>
        <View style={{ gap: 8 }}>
          <T variant="caption" tone="secondary">
            Lifecycle
          </T>
          {detail.group.status === "active" && (
            <Button secondary busy={busy} onPress={() => void control("pause")}>
              Pause agents
            </Button>
          )}
          {(detail.group.status === "paused" || detail.group.status === "stopped") && (
            <Button secondary busy={busy} onPress={() => void control("resume")}>
              Resume agents
            </Button>
          )}
          {detail.group.status !== "stopped" && detail.group.status !== "completed" && (
            <Button danger busy={busy} onPress={() => void control("stop")}>
              Stop agents
            </Button>
          )}
          {!persistentCoordinator && detail.group.status !== "completed" && (
            <Button secondary busy={busy} onPress={() => void control("complete")}>
              Mark complete
            </Button>
          )}
        </View>
        {groups.some((item) => item.group.id !== detail.group.id) && (
          <View style={{ gap: 8 }}>
            <T variant="caption" tone="secondary">Previous agents</T>
            {groups
              .filter((item) => item.group.id !== detail.group.id)
              .map((item) => (
                <Tap
                  key={item.group.id}
                  label={`Open previous agents: ${item.group.objective}`}
                  onPress={() => onSelect(item.group.id)}
                  style={{ paddingHorizontal: 12, paddingVertical: 6 }}
                >
                  <View style={[styles.spread, { gap: 12 }]}>
                    <View style={{ flex: 1, gap: 3 }}>
                      <T variant="label" numberOfLines={1}>{item.group.objective}</T>
                      <T variant="caption" tone="secondary">
                        {sentenceCase(item.group.status)} · {formatDateTime(item.group.updated_at)}
                      </T>
                    </View>
                    <Icon name="chevron.right" size={15} />
                  </View>
                </Tap>
              ))}
          </View>
        )}
        <View style={{ gap: 8 }}>
          <T variant="caption" tone="secondary">
            Advanced
          </T>
          <Button
            secondary
            onPress={() => {
              onClose();
              onOpen("objective");
            }}
          >
            Edit objective
          </Button>
          <Button
            secondary
            icon="slider.horizontal.3"
            onPress={() => {
              onClose();
              onOpen("settings");
            }}
          >
            Mode and policy
          </Button>
          <Button
            secondary
            icon="person.2"
            onPress={() => {
              onClose();
              onOpen("participants");
            }}
          >
            Manage threads
          </Button>
        </View>
      </View>
    </CollaborationSheet>
  );
}

function GroupSettingsSheet({
  detail,
  coordinator,
  providers,
  busy,
  run,
  visible,
  onClose,
}: {
  detail: CollaborationGroupDetail;
  coordinator?: Thread;
  providers: ProviderStatus[];
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState(detail.group.coordinator_mode);
  const [allowed, setAllowed] = useState<ProviderKind[]>(
    detail.group.policy.allowed_providers.length
      ? detail.group.policy.allowed_providers
      : providers.filter((provider) => provider.available).map((provider) => provider.kind),
  );
  const [workers, setWorkers] = useState(detail.group.policy.max_active_workers);
  const [depth, setDepth] = useState(detail.group.policy.max_depth);
  const [baseline, setBaseline] = useState({
    revision: detail.group.revision,
    mode: detail.group.coordinator_mode,
    allowed:
      detail.group.policy.allowed_providers.length
        ? detail.group.policy.allowed_providers
        : providers.filter((provider) => provider.available).map((provider) => provider.kind),
    workers: detail.group.policy.max_active_workers,
    depth: detail.group.policy.max_depth,
    policy: detail.group.policy,
  });
  const unsupported = coordinator ? dedicatedUnsupported(coordinator.provider.kind) : false;
  const { colors } = useTheme();
  useEffect(() => {
    if (visible) {
      const nextAllowed =
        detail.group.policy.allowed_providers.length
          ? detail.group.policy.allowed_providers
          : providers.filter((provider) => provider.available).map((provider) => provider.kind);
      const next = {
        revision: detail.group.revision,
        mode: detail.group.coordinator_mode,
        allowed: nextAllowed,
        workers: detail.group.policy.max_active_workers,
        depth: detail.group.policy.max_depth,
        policy: detail.group.policy,
      };
      setBaseline(next);
      setMode(next.mode);
      setAllowed(next.allowed);
      setWorkers(next.workers);
      setDepth(next.depth);
    }
  }, [visible, detail.group.id]);
  const modeOptions: ChoiceOption<"ordinary" | "dedicated">[] = [
    {
      value: "ordinary",
      label: "Ordinary",
      detail: "Plan and work in the coordinator thread.",
    },
    ...(!unsupported
      ? [
          {
            value: "dedicated" as const,
            label: "Dedicated",
            detail: "Plan and review while helper agents make changes.",
          },
        ]
      : []),
  ];
  const workerOptions = Array.from({ length: 32 }, (_, index) => index + 1).map((value) => ({
    value,
    label: `${value} active ${value === 1 ? "helper" : "helpers"}`,
  }));
  const depthOptions = Array.from({ length: 9 }, (_, index) => ({
    value: index,
    label: `${index} ${index === 1 ? "level" : "levels"}`,
  }));
  const policyChanged =
    workers !== baseline.workers ||
    depth !== baseline.depth ||
    allowed.join() !== baseline.allowed.join();
  const changed = mode !== baseline.mode || policyChanged;
  async function save() {
    if (!changed) return;
    const ok = await run(async () => {
      await releaseCoordinatorForMode(
        coordinator,
        baseline.mode,
        mode,
        policyChanged,
      );
      await rpc("collaboration.groups.update", {
        operation_id: randomUUID(),
        group_id: detail.group.id,
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
      });
    });
    if (ok) onClose();
  }
  return (
    <CollaborationSheet visible={visible} title="Mode and policy" onClose={onClose}>
      <View style={{ gap: 18 }}>
        <ChoiceField label="Coordinator mode" value={mode} options={modeOptions} onChange={setMode} />
        {unsupported && (
          <T variant="caption" tone="secondary">
            This coordinator cannot enforce dedicated mode. Ordinary mode is
            required for this agent.
          </T>
        )}
        <View style={{ gap: 8 }}>
          <T variant="label">Allowed agents</T>
          <View style={{ gap: 5 }}>
            {providers.map((provider) => {
              const selected = allowed.includes(provider.kind);
              const disabled = !provider.available && !selected;
              return (
                <Tap
                  key={provider.kind}
                  label={`${provider.display_name}, ${selected ? "allowed" : "blocked"}`}
                  disabled={disabled}
                  selected={selected}
                  onPress={() =>
                    setAllowed((current) =>
                      selected
                        ? current.filter((kind) => kind !== provider.kind)
                        : [...current, provider.kind],
                    )
                  }
                  style={{
                    ...styles.spread,
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    borderRadius: 14,
                    backgroundColor: selected ? colors.accentSoft : colors.raised,
                  }}
                >
                  <View style={[styles.line, { flex: 1 }]}>
                    <ProviderMark kind={provider.kind} size={20} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T variant="label">{provider.display_name}</T>
                      <T variant="caption" tone="secondary">
                        {provider.available ? "Available" : "Unavailable on this computer"}
                      </T>
                    </View>
                  </View>
                  {selected && <Icon name="checkmark" size={17} color={colors.accent} />}
                </Tap>
              );
            })}
          </View>
        </View>
        <ChoiceField label="Active helpers" value={workers} options={workerOptions} onChange={setWorkers} />
        <ChoiceField label="Helper depth" value={depth} options={depthOptions} onChange={setDepth} />
        <Button
          secondary
          busy={busy}
          disabled={
            !changed ||
            !allowed.length ||
            (mode === "dedicated" && unsupported)
          }
          onPress={() => void save()}
        >
          Save mode and policy
        </Button>
      </View>
    </CollaborationSheet>
  );
}

function ParticipantsSheet({
  detail,
  currentThreadId,
  threads,
  busy,
  run,
  visible,
  onClose,
}: {
  detail: CollaborationGroupDetail;
  currentThreadId: string;
  threads: Thread[];
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const candidates = threads.filter(
    (thread) =>
      thread.status !== "archived" &&
      !detail.members.some((member) => member.thread_id === thread.id),
  );
  const [candidateId, setCandidateId] = useState("");
  const [role, setRole] = useState<Exclude<GroupMemberRole, "coordinator">>("worker");
  const candidateIds = candidates.map((candidate) => candidate.id).join(",");
  useEffect(() => {
    if (visible && !candidates.some((candidate) => candidate.id === candidateId))
      setCandidateId(candidates[0]?.id ?? "");
  }, [visible, candidateIds, detail.group.id]);
  const candidateOptions: ChoiceOption<string>[] = candidates.map((candidate) => ({
    value: candidate.id,
    label: candidate.title || "Untitled thread",
    detail: `${sentenceCase(candidate.provider.kind)} · ${candidate.status}`,
  }));
  const roleOptions: ChoiceOption<Exclude<GroupMemberRole, "coordinator">>[] =
    (Object.keys(roleLabels) as Exclude<GroupMemberRole, "coordinator">[]).map((value) => ({
      value,
      label: roleLabels[value],
      detail:
        value === "reviewer"
          ? "Review worker output and report concerns."
          : value === "integrator"
            ? "Coordinate changes at the integration boundary."
            : value === "observer"
              ? "Keep a reference thread without assigning work."
              : "Take focused assignments from the coordinator.",
    }));
  async function attach() {
    if (!candidateId) return;
    const ok = await run(() =>
      rpc("collaboration.members.attach", {
        operation_id: randomUUID(),
        group_id: detail.group.id,
        thread_id: candidateId,
        role,
      }),
    );
    if (ok) onClose();
  }
  return (
    <CollaborationSheet visible={visible} title="Manage threads" onClose={onClose}>
      <View style={{ gap: 18 }}>
        <View style={{ gap: 8 }}>
          <T variant="label">Current threads</T>
          {detail.members.map((member) => {
            const participant = threads.find((thread) => thread.id === member.thread_id);
            return (
              <View
                key={member.thread_id}
                style={[styles.line, { alignItems: "flex-start", paddingVertical: 8 }]}
              >
                {participant && <ProviderMark kind={participant.provider.kind} size={20} />}
                <View style={{ flex: 1, gap: 2 }}>
                  <T variant="label">{participant?.title || member.thread_id.slice(0, 8)}</T>
                  <T variant="caption" tone="secondary">
                    {member.role === "coordinator"
                      ? "Coordinator"
                      : roleLabels[member.role as Exclude<GroupMemberRole, "coordinator">]}
                    {member.active ? " · Active" : " · Reference"}
                  </T>
                </View>
                {member.role !== "coordinator" && (
                  <Tap
                    label={`Detach ${participant?.title || "thread"}`}
                    onPress={() =>
                      void run(() =>
                        rpc("collaboration.members.detach", {
                          operation_id: randomUUID(),
                          group_id: detail.group.id,
                          thread_id: member.thread_id,
                        }),
                      )
                    }
                  >
                    <T variant="caption" tone="negative">
                      Detach
                    </T>
                  </Tap>
                )}
              </View>
            );
          })}
        </View>
        {candidates.length ? (
          <>
            <ChoiceField
              label="Existing thread"
              value={candidateId}
              options={candidateOptions}
              onChange={setCandidateId}
            />
            <ChoiceField
              label="Role"
              value={role}
              options={roleOptions}
              onChange={setRole}
            />
            <Button busy={busy} onPress={() => void attach()}>
              Attach thread
            </Button>
          </>
        ) : (
          <T variant="caption" tone="secondary">
            All project threads are already represented in this group.
          </T>
        )}
      </View>
    </CollaborationSheet>
  );
}

function StartAgentSheet({
  thread,
  group,
  providers,
  starter,
  busy,
  run,
  visible,
  onClose,
}: {
  thread: Thread;
  group?: CollaborationGroupDetail["group"];
  providers: ProviderStatus[];
  starter: ReturnType<typeof createAgentStarter>;
  busy: boolean;
  run: (
    work: () => Promise<unknown>,
    onError?: (message: string) => void,
  ) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const [providerKind, setProviderKind] = useState<ProviderKind>(
    providers[0]?.kind ?? "claude-code",
  );
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<AssignmentKind>("edit");
  const [baseRevision, setBaseRevision] = useState("");
  const [submitError, setSubmitError] = useState("");
  const provider = providers.find((item) => item.kind === providerKind) ?? providers[0];
  const providerKinds = providers.map((item) => item.kind).join(",");
  const modelIds = (provider?.models ?? []).map((item) => item.id).join(",");

  useEffect(() => {
    if (providers.length && !providers.some((item) => item.kind === providerKind)) {
      setProviderKind(providers[0].kind);
      setModel("");
    }
  }, [providerKinds, providerKind, providers.length]);
  useEffect(() => {
    if (model && !provider?.models?.some((item) => item.id === model)) setModel("");
  }, [model, modelIds, providerKind]);

  const providerOptions: ChoiceOption<ProviderKind>[] = providers.map((item) => ({
    value: item.kind,
    label: item.display_name,
    detail: "Available on this computer",
  }));
  const modelOptions: ChoiceOption<string>[] = [
    { value: "", label: "Provider default", detail: "Let the provider choose." },
    ...(provider?.models ?? []).map((item) => ({ value: item.id, label: item.display_name })),
  ];
  const kindOptions: ChoiceOption<AssignmentKind>[] = (
    Object.keys(assignmentKindLabels) as AssignmentKind[]
  ).map((value) => ({ value, label: assignmentKindLabels[value] }));

  async function start() {
    if (!provider || !task.trim()) return;
    setSubmitError("");
    const ok = await run(
      () =>
        starter.start({
          thread,
          group,
          provider,
          task,
          ...(model ? { model } : {}),
          ...(title.trim() ? { title } : {}),
          kind,
          ...(baseRevision.trim() ? { baseRevision } : {}),
        }),
      (message) => {
        setSubmitError(message);
        if (message.includes("detached")) setAdvanced(true);
      },
    );
    if (!ok) return;
    setTask("");
    setModel("");
    setTitle("");
    setKind("edit");
    setBaseRevision("");
    setAdvanced(false);
    onClose();
  }

  const paused = group?.status === "paused" || group?.status === "stopped";
  return (
    <CollaborationSheet visible={visible} title="Start agent" onClose={onClose}>
      <View style={{ gap: 18 }}>
        <ErrorBanner error={submitError} />
        <T tone="secondary">
          Starting queues the task. Editing and integration tasks use a separate
          Git workspace; uncommitted changes aren’t included. Research and
          review can also start in projects without Git.
        </T>
        {providers.length ? (
          <>
            <ChoiceField
              label="Provider"
              value={providerKind}
              options={providerOptions}
              onChange={(value) => {
                setProviderKind(value);
                setModel("");
              }}
            />
            <Field
              label="Task"
              value={task}
              onChangeText={setTask}
              multiline
              style={{ minHeight: 126 }}
              placeholder="What should this agent do and report back?"
            />
            <ChoiceField label="Model (optional)" value={model} options={modelOptions} onChange={setModel} />
            <Tap
              label={advanced ? "Hide advanced options" : "Show advanced options"}
              expanded={advanced}
              onPress={() => setAdvanced((value) => !value)}
              style={{ paddingHorizontal: 2 }}
            >
              <View style={[styles.spread, { minHeight: 44 }]}>
                <T variant="label" tone="accent">Advanced</T>
                <Icon name={advanced ? "chevron.up" : "chevron.down"} size={16} />
              </View>
            </Tap>
            {advanced && (
              <View style={{ gap: 16 }}>
                <Field label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Short agent name" />
                <ChoiceField label="Kind" value={kind} options={kindOptions} onChange={setKind} />
                <Field
                  label="Base revision (optional)"
                  value={baseRevision}
                  onChangeText={setBaseRevision}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="Branch or commit"
                />
                <T variant="caption" tone="secondary">
                  A base revision is required only when this thread is detached or you want another starting point.
                </T>
              </View>
            )}
            {paused && (
              <T variant="caption" tone="warning">
                Resume agents before starting another agent.
              </T>
            )}
            <Button busy={busy} disabled={!task.trim() || paused} onPress={() => void start()}>
              Start agent
            </Button>
          </>
        ) : (
          <T tone="secondary">Set up an available provider on the connected computer first.</T>
        )}
      </View>
    </CollaborationSheet>
  );
}

function MessageSheet({
  detail,
  currentThreadId,
  threads,
  busy,
  run,
  visible,
  onClose,
}: {
  detail: CollaborationGroupDetail;
  currentThreadId: string;
  threads: Thread[];
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const targets = detail.members.filter(
    (member) => member.active && member.thread_id !== currentThreadId,
  );
  const [targetId, setTargetId] = useState("");
  const [body, setBody] = useState("");
  const targetIds = targets.map((target) => target.thread_id).join(",");
  useEffect(() => {
    if (visible && !targets.some((target) => target.thread_id === targetId))
      setTargetId(targets[0]?.thread_id ?? "");
  }, [visible, targetIds, detail.group.id]);
  const targetOptions: ChoiceOption<string>[] = targets.map((member) => {
    const target = threads.find((thread) => thread.id === member.thread_id);
    return {
      value: member.thread_id,
      label: target?.title || member.thread_id.slice(0, 8),
      detail: target ? sentenceCase(target.provider.kind) : "Active participant",
    };
  });
  async function send() {
    if (!targetId || !body.trim()) return;
    const ok = await run(async () => {
      await rpc("collaboration.messages.send", {
        operation_id: randomUUID(),
        group_id: detail.group.id,
        to_thread_id: targetId,
        purpose: "progress",
        body: body.trim(),
      });
      setBody("");
    });
    if (ok) onClose();
  }
  return (
    <CollaborationSheet visible={visible} title="Save note" onClose={onClose}>
      <View style={{ gap: 18 }}>
        <T tone="secondary">
          This saves an informational note and does not wake the recipient. To
          ask for work or a reply, open the agent thread and send a message.
        </T>
        {targetOptions.length ? (
          <>
            <ChoiceField
              label="Recipient"
              value={targetId}
              options={targetOptions}
              onChange={setTargetId}
            />
            <Field
              label="Note"
              value={body}
              onChangeText={setBody}
              multiline
              style={{ minHeight: 126 }}
              placeholder="Share a finding or status"
            />
            <Button busy={busy} disabled={!body.trim()} onPress={() => void send()}>
              Save note
            </Button>
          </>
        ) : (
          <T variant="caption" tone="secondary">
            Start a helper before saving a note for it.
          </T>
        )}
      </View>
    </CollaborationSheet>
  );
}

function ContextEditorSheet({
  groupId,
  entry,
  busy,
  run,
  visible,
  onClose,
}: {
  groupId: string;
  entry: ContextEntry | null;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
  visible: boolean;
  onClose: () => void;
}) {
  const kinds = Object.keys(contextKindLabels) as ContextEntryKind[];
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<ContextEntryKind>("instruction");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (visible) {
      setKey(entry?.key ?? "");
      setKind(entry?.kind ?? "instruction");
      setBody(entry?.body ?? "");
    }
  }, [visible, entry?.id]);
  const kindOptions: ChoiceOption<ContextEntryKind>[] = kinds.map((value) => ({
    value,
    label: contextKindLabels[value],
    detail:
      value === "instruction"
        ? "A user-authored direction for future work."
        : value === "plan"
          ? "The coordinator’s current persisted plan."
        : value === "decision"
          ? "A decision the group should keep using."
          : value === "result_reference"
            ? "A pointer to a completed result or artifact."
            : value === "research"
              ? "Evidence gathered by a worker."
              : "A concise brief shared across workers.",
  }));
  async function save() {
    if (!key.trim() || !body.trim()) return;
    const ok = await run(() =>
      rpc("collaboration.context.put", {
        operation_id: randomUUID(),
        group_id: groupId,
        ...(entry
          ? { entry_id: entry.id, expected_revision: entry.revision }
          : {}),
        key: key.trim(),
        kind,
        body: body.trim(),
        user_authored: true,
      }),
    );
    if (ok) onClose();
  }
  return (
    <CollaborationSheet
      visible={visible}
      title={entry ? (entry.user_authored ? "Edit shared note" : "Correct shared note") : "Add shared note"}
      onClose={onClose}
    >
      <View style={{ gap: 18 }}>
        <T tone="secondary">
          {entry && !entry.user_authored
            ? "Your correction becomes the authoritative revision. The agent’s earlier version remains in history."
            : "Helpers can read this note. Earlier saved versions remain available."}
        </T>
        <Field
          label="Name"
          value={key}
          onChangeText={setKey}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="For example, release-checks"
        />
        <ChoiceField label="Kind" value={kind} options={kindOptions} onChange={setKind} />
        <Field
          label="Content"
          value={body}
          onChangeText={setBody}
          multiline
          style={{ minHeight: 150 }}
          placeholder="What should every future assignment know?"
        />
        <Button busy={busy} disabled={!key.trim() || !body.trim()} onPress={() => void save()}>
          {entry ? "Save context" : "Add context"}
        </Button>
      </View>
    </CollaborationSheet>
  );
}

function groupControl(
  groupId: string,
  action: "pause" | "stop" | "resume" | "complete",
) {
  return rpc("collaboration.groups.control", {
    operation_id: randomUUID(),
    group_id: groupId,
    action,
  });
}
