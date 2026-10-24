import { threadHasActivity } from "../src/state/runtime";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../src/features/Composer";
import { setDraft, useDraft } from "../src/state/draft";
import { plural } from "../src/state/format";
import { isFreeChatProject, type TaskItem, type Thread, type UserMessage } from "../src/state/protocol";
import { ensureThread, refresh, rpc, startNewChat, supportsOptimisticCreate, useApp } from "../src/state/runtime";
import { newThreadId } from "../src/state/ids";
import { groupCreateFields, supportsWorktree } from "../src/state/groups";
import { useInSpace, useSpaceProjects } from "../src/state/spaces";
import { sendTask, useTasks } from "../src/state/tasks";
import { PRIORITY_LABEL, taskTitle, upNextTasks } from "../src/state/tasksModel";
import { relativeTime } from "../src/state/threadList";
import { isGroupProject } from "../../../packages/kybern-client/src/groups";
import { optimisticThread } from "../../../packages/kybern-client/src/newChat";
import { isSubagentThread } from "../../../packages/kybern-client/src/subagents";
import { useLayout } from "../src/state/layout";
import { Brand } from "../src/ui/Brand";
import { ChromeBar, ChromeProvider, useChromeInsets } from "../src/ui/ChromeBar";
import { ListRow, SectionHeader } from "../src/ui/List";
import { Button, Icon, IconButton, T, Tap, type IconName } from "../src/ui/primitives";
import { PriorityGlyph } from "../src/ui/TaskGlyphs";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../src/ui/theme";
import { useSendTransition } from "../src/components/liquid/SendTransition";
import { DRAFT_SEND_THREAD, outgoingBlock } from "../src/state/sendTransition";
import { UserMessageBubble } from "../src/features/UserMessageBubble";

/** Rows per pick-up group: Continue and Up next. */
const PICKUP_ROWS = 3;

const SUGGESTIONS: readonly { icon: IconName; title: string; prompt: string }[] = [
  { icon: "hammer", title: "Build something new", prompt: "Help me build " },
  {
    icon: "viewfinder",
    title: "Explore this project",
    prompt: "Explore this project and explain how it is organized.",
  },
  {
    icon: "arrow.triangle.branch",
    title: "Review recent changes",
    prompt: "Review the recent changes in this project. Look for bugs and improvements.",
  },
];

/** The project's most recent top-level threads (no subagents, delegated children or archived). */
function continueThreads(threads: readonly Thread[], projectId: string | undefined) {
  if (!projectId) return [];
  return threads
    .filter(
      (t) =>
        t.project_id === projectId &&
        !t.parent_thread_id &&
        !isSubagentThread(t) &&
        !t.delegation &&
        t.status !== "archived",
    )
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, PICKUP_ROWS);
}

/** A quiet chip in the footer: an icon, a value and a chevron. */
function FooterChip({
  icon,
  label,
  value,
  onPress,
  chevron = true,
}: {
  icon: IconName;
  label: string;
  value: string;
  onPress: () => void;
  chevron?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      label={label}
      feedback="highlight"
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 36,
        paddingHorizontal: space.sm,
        borderRadius: radius.full,
        flexShrink: 1,
      }}
    >
      <Icon name={icon} size={15} color={colors.secondary} />
      <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flexShrink: 1 }}>
        {value}
      </T>
      {chevron && <Icon name="chevron.down" size={9} color={colors.muted} />}
    </Tap>
  );
}

/** The task a new chat will start, shown above the composer with a way to take it off. */
function AttachedTask({ task, onRemove }: { task: TaskItem; onRemove: () => void }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`Sending starts ${task.key}, ${taskTitle(task)}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        marginHorizontal: space.lg,
        paddingStart: space.md,
        borderRadius: radius.md,
        backgroundColor: colors.accentSoft,
      }}
    >
      <Icon name="checklist" size={15} color={colors.accent} />
      <T variant="footnote" tone="accent" numberOfLines={1} style={{ flex: 1 }}>
        <T variant="footnote" tone="accent" style={{ fontWeight: "600" }}>
          {task.key}
        </T>
        {`  ${taskTitle(task)}`}
      </T>
      <IconButton name="xmark" size={14} color={colors.accent} label={`Remove ${task.key}`} onPress={onRemove} />
    </View>
  );
}

function HomeScreen() {
  const app = useApp();
  const draft = useDraft();
  const { tasks } = useTasks();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const { regular, sidebarOpen, toggleSidebar } = useLayout();
  const insets = useSafeAreaInsets();
  const chrome = useChromeInsets();
  const sendMotion = useSendTransition();
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const outgoing =
    sendMotion.outgoing?.sourceThreadId === DRAFT_SEND_THREAD
      ? sendMotion.outgoing
      : null;
  useEffect(() => {
    if (focused && outgoing?.receipt && sendMotion.flight?.id !== outgoing.id)
      // On a wide layout the home screen is the detail pane, so swap it in place
      // rather than pushing another entry onto the detail stack.
      (regular ? router.navigate : router.push)({
        pathname: "/thread/[id]",
        params: { id: outgoing.receipt.threadId, created: "1" },
      });
  }, [
    focused,
    regular,
    outgoing?.receipt?.threadId,
    outgoing?.id,
    sendMotion.flight?.id,
  ]);
  const [prompt, setPrompt] = useState("");
  const [attachedId, setAttachedId] = useState<string | null>(null);
  const connected = app.status === "open";
  // Home works in the active space: a draft project from another space gives way to this one's first.
  const spaceProjects = useSpaceProjects();
  const project =
    spaceProjects.find((p) => p.id === draft.projectId) ??
    spaceProjects.find((p) => !isFreeChatProject(p.id)) ??
    spaceProjects[0];
  const workspaceLabel = draft.worktree ? "Worktree" : "This checkout";
  const recent = useMemo(() => continueThreads(app.threads, project?.id), [app.threads, project?.id]);
  const upNext = useMemo(() => upNextTasks(tasks, project?.id ?? null, PICKUP_ROWS), [tasks, project?.id]);
  // A task from another project falls off when the project changes.
  const attached = tasks.find((t) => t.id === attachedId && t.project_id === project?.id) ?? null;
  useEffect(() => {
    if (attachedId && !attached) setAttachedId(null);
  }, [attachedId, attached]);
  const active = app.threads.filter((t) =>
    threadHasActivity(t, app.activity),
  ).length;
  useEffect(() => {
    if (project && project.id !== draft.projectId)
      setDraft({ projectId: project.id });
    if (
      app.providers.length &&
      !app.providers.some((p) => p.kind === draft.provider && p.available)
    ) {
      const first = app.providers.find((p) => p.available);
      if (first)
        setDraft({
          provider: first.kind,
          instance: first.instances[0] ?? "default",
          model: "",
          effort: "",
          permission: first.supported_permission_modes.includes(draft.permission)
            ? draft.permission : first.supported_permission_modes[0] ?? "supervised",
        });
    }
    const selected = app.providers.find((p) => p.kind === draft.provider && p.available);
    if (selected && !selected.supported_permission_modes.includes(draft.permission)) {
      setDraft({ permission: selected.supported_permission_modes[0] ?? "supervised" });
    }
  }, [project?.id, app.providers, draft.projectId, draft.provider, draft.permission]);
  async function send(message: UserMessage) {
    if (!project) throw new Error("Add a project before starting a thread.");
    const provider = { kind: draft.provider, instance: draft.instance };
    const worktree = draft.worktree && supportsWorktree(project);
    if (attached) return startTask(attached, message, provider, worktree);
    const params = {
      project_id: project.id,
      provider,
      permission_mode: draft.permission,
      use_worktree: worktree,
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      // A group names a base branch per repository instead.
      ...(draft.baseBranch && !isGroupProject(project) ? { base_branch: draft.baseBranch } : {}),
      ...groupCreateFields(project, draft, worktree),
    };
    if (!supportsOptimisticCreate()) {
      // An older daemon names the thread itself: wait for it, then open that thread.
      const thread = await rpc("threads.create", { ...params, message });
      void refresh();
      await ensureThread(thread.id).catch(() => {});
      return { threadId: thread.id };
    }
    // Optimistic: the thread id is ours, so the receipt is immediate and the thread opens with the
    // message in flight while the daemon makes it. A failure shows on the thread with Retry.
    const threadId = newThreadId();
    const messageId = newThreadId();
    startNewChat(
      {
        threadId,
        messageId,
        message,
        worktree,
        thread: optimisticThread({
          id: threadId,
          projectId: project.id,
          provider,
          model: draft.model || null,
          effort: draft.effort || null,
          permissionMode: draft.permission,
          message,
        }),
      },
      (first, id) => rpc("threads.create", { ...params, message: first, thread_id: threadId, message_id: id }),
    );
    return { threadId, messageId };
  }
  /**
   * Up next: the message starts the attached task's next run (`tasks.items.send`).
   * The task leads the message as its mention, as the daemon would add it, so the
   * first bubble shows it at once.
   */
  async function startTask(
    task: TaskItem,
    message: UserMessage,
    provider: { kind: typeof draft.provider; instance: string },
    worktree: boolean,
  ) {
    const pending = task.pending_followup?.trim();
    const sent: UserMessage = {
      ...message,
      parts: [
        { type: "mention", name: task.key, path: `kybern://task/${task.id}`, display_name: `${task.key} ${task.title}` },
        ...(pending ? [{ type: "text" as const, text: pending }] : []),
        ...message.parts,
      ],
    };
    const params = {
      id: task.id,
      provider,
      model: draft.model || null,
      effort: draft.effort || null,
      permission_mode: draft.permission,
      use_worktree: worktree,
      base_branch: worktree && project && !isGroupProject(project) ? (draft.baseBranch ?? null) : null,
      project_id: project!.id,
      note_ids: [...new Set([...task.note_ids, ...(task.source_note_id ? [task.source_note_id] : [])])],
    };
    setAttachedId(null);
    if (!supportsOptimisticCreate()) {
      const result = await sendTask({ ...params, message: sent });
      void refresh();
      await ensureThread(result.thread_id).catch(() => {});
      return { threadId: result.thread_id };
    }
    const threadId = newThreadId();
    const messageId = newThreadId();
    startNewChat(
      {
        threadId,
        messageId,
        message: sent,
        worktree,
        thread: optimisticThread({
          id: threadId,
          projectId: project!.id,
          provider,
          model: draft.model || null,
          effort: draft.effort || null,
          permissionMode: draft.permission,
          message: sent,
          title: task.title,
        }),
      },
      (first, id) =>
        sendTask({ ...params, message: first, thread_id: threadId, message_id: id }).then(
          (result) => result.thread_id,
        ),
    );
    return { threadId, messageId };
  }
  const pickup = connected && !outgoing && (recent.length > 0 || upNext.length > 0);
  const open = (thread: Thread) =>
    router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {regular ? (
        // The sidebar already carries the brand, threads, and settings, so the
        // split-view home is a clean canvas — just a way back to the rail when
        // it is collapsed.
        <View
          style={{
            paddingTop: insets.top + space.sm,
            paddingHorizontal: space.md,
            paddingBottom: space.xs,
            minHeight: 40,
            flexDirection: "row",
          }}
        >
          {!sidebarOpen && (
            <IconButton
              name="sidebar.left"
              label="Show sidebar"
              onPress={toggleSidebar}
            />
          )}
        </View>
      ) : (
        // 44 pt targets on an 8 pt grid: Threads leads, the wordmark centres,
        // Tasks and Notes trail. Settings lives on the Threads screen.
        <View
          style={{
            paddingTop: insets.top + space.xs,
            paddingHorizontal: space.sm,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, alignItems: "flex-start" }}>
            <IconButton
              name="list.bullet"
              label="Threads"
              onPress={() => router.push("/library")}
            />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <Brand size={20} />
            <T variant="headline">kybern</T>
          </View>
          <View style={{ flex: 1, flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
            <IconButton
              name="checklist"
              label="Tasks"
              onPress={() => router.push("/todo")}
            />
            <IconButton
              name="doc.text"
              label="Notes"
              onPress={() => router.push("/notes")}
            />
          </View>
        </View>
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: space.xl,
          paddingBottom: chrome.bottom + space.lg,
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          alignSelf: "center",
        }}
      >
        {outgoing ? (
          <View style={{ paddingHorizontal: gutter(width) }}>
            <UserMessageBubble
              block={outgoingBlock(outgoing)}
              threadId={outgoing.threadId}
            />
          </View>
        ) : (
          <Animated.View
            entering={FadeIn.duration(280).reduceMotion(ReduceMotion.System)}
            style={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: gutter(width), paddingBottom: space.xl }}
          >
            <T variant="largeTitle" accessibilityRole="header">What are we building?</T>
            <T variant="subhead" tone="secondary" style={{ marginTop: space.sm, maxWidth: 320 }}>
              {!connected
                ? "Work with your coding agents from anywhere."
                : upNext.length
                  ? "Start a thread, or pick a task to send."
                  : "Start a thread in this project."}
            </T>
            {!connected && (
              <View style={{ marginTop: space.xl, alignSelf: "flex-start" }}>
                <Button
                  onPress={() =>
                    app.activeId
                      ? router.push("/settings")
                      : router.push("/connect")
                  }
                  icon="arrow.right"
                >
                  {app.activeId ? "Open connections" : "Connect your computer"}
                </Button>
              </View>
            )}
          </Animated.View>
        )}
        {pickup && (
          <View>
            {recent.length > 0 && (
              <>
                <SectionHeader
                  title="Continue"
                  action={{ title: "See all", label: "See all threads", onPress: () => router.push("/library") }}
                  inset
                  first
                />
                {recent.map((thread, index) => {
                  const working = threadHasActivity(thread, app.activity);
                  return (
                    <ListRow
                      key={thread.id}
                      title={thread.title || "Untitled thread"}
                      meta={
                        thread.status === "awaiting-approval"
                          ? "Needs you"
                          : working
                            ? "Working"
                            : relativeTime(thread.updated_at)
                      }
                      separator={index < recent.length - 1}
                      onPress={() => open(thread)}
                    />
                  );
                })}
              </>
            )}
            {upNext.length > 0 && (
              <>
                <SectionHeader
                  title="Up next"
                  action={{ title: "Tasks", label: "Open tasks", onPress: () => router.push("/todo") }}
                  inset
                  first={!recent.length}
                />
                {upNext.map((task, index) => (
                  <ListRow
                    key={task.id}
                    title={taskTitle(task)}
                    leading={<PriorityGlyph priority={task.priority} size={16} />}
                    meta={task.key}
                    checked={task.id === attached?.id}
                    label={[
                      task.key,
                      taskTitle(task),
                      task.priority ? `${PRIORITY_LABEL[task.priority]} priority` : "",
                      task.id === attached?.id ? "attached, sending starts it" : "attach to the message",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    separator={index < upNext.length - 1}
                    onPress={() => setAttachedId(task.id === attached?.id ? null : task.id)}
                  />
                ))}
              </>
            )}
          </View>
        )}
        {connected && !outgoing && !pickup && (
          <View>
            {SUGGESTIONS.map((item) => (
              <ListRow
                key={item.title}
                title={item.title}
                leading={item.icon}
                onPress={() => setPrompt(item.prompt)}
              />
            ))}
          </View>
        )}
      </ScrollView>
      <KeyboardStickyView
        offset={{ closed: 0, opened: insets.bottom }}
        style={{ position: "absolute", start: 0, end: 0, bottom: 0 }}
      >
        <ChromeBar edge="bottom" style={{ position: "relative" }}>
          <View
            style={{
              width: "100%",
              maxWidth: CONTENT_MAX_WIDTH,
              alignSelf: "center",
              paddingTop: space.xs,
              paddingBottom: space.sm,
              gap: space.xs,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                paddingHorizontal: space.sm,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, flexShrink: 1 }}>
                <FooterChip
                  icon="folder"
                  label={project ? `Change project, ${project.name}` : "Add a project"}
                  value={project?.name ?? (connected ? "Choose a project" : "No computer connected")}
                  chevron={!!project}
                  onPress={() => router.push(connected ? "/project-picker" : "/connect")}
                />
                {connected && supportsWorktree(project) && (
                  <FooterChip
                    icon="arrow.triangle.branch"
                    label={`Thread setup, ${workspaceLabel}`}
                    value={workspaceLabel}
                    onPress={() => router.push("/configure")}
                  />
                )}
              </View>
              {(active > 0 || app.approvals.length > 0) && (
                <Tap
                  label="View agent activity"
                  feedback="highlight"
                  onPress={() => router.push("/activity")}
                  style={{ flexDirection: "row", alignItems: "center", minHeight: 36, paddingHorizontal: space.sm, borderRadius: radius.full }}
                >
                  <T variant="footnote" tone="accent" style={{ fontWeight: "600" }}>
                    {app.approvals.length
                      ? plural(app.approvals.length, { one: "{n} needs you", other: "{n} need you" })
                      : `${active} working`}
                  </T>
                </Tap>
              )}
            </View>
            {attached && <AttachedTask task={attached} onRemove={() => setAttachedId(null)} />}
            <Composer
              onSend={send}
              disabled={!connected || !project}
              prompt={prompt}
              onPromptConsumed={() => setPrompt("")}
            />
          </View>
        </ChromeBar>
      </KeyboardStickyView>
    </View>
  );
}

export default function Home() {
  return (
    <ChromeProvider>
      <HomeScreen />
    </ChromeProvider>
  );
}
