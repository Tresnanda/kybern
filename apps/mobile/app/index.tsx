import { threadHasActivity } from "../src/state/runtime";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../src/features/Composer";
import { ComputerSwitcher } from "../src/features/ComputerSwitcher";
import { SpaceSwitcher } from "../src/features/Spaces";
import { setDraft, useDraft } from "../src/state/draft";
import { plural } from "../src/state/format";
import { isFreeChatProject, type Thread, type UserMessage } from "../src/state/protocol";
import { ensureThread, refresh, rpc, startNewChat, supportsOptimisticCreate, useApp } from "../src/state/runtime";
import { newThreadId } from "../src/state/ids";
import { groupCreateFields, supportsWorktree } from "../src/state/groups";
import { useInSpace, useSpaceProjects } from "../src/state/spaces";
import { ownerFirstName, relativeTime } from "../src/state/threadList";
import { isGroupProject } from "../../../packages/kybern-client/src/groups";
import { optimisticThread } from "../../../packages/kybern-client/src/newChat";
import { isSubagentThread } from "../../../packages/kybern-client/src/subagents";
import { useLayout } from "../src/state/layout";
import { ChromeBar, ChromeProvider, useChromeInsets } from "../src/ui/ChromeBar";
import { ListRow, SectionHeader } from "../src/ui/List";
import { Button, Icon, IconButton, T, Tap, type IconName } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../src/ui/theme";
import { useSendTransition } from "../src/components/liquid/SendTransition";
import { DRAFT_SEND_THREAD, outgoingBlock } from "../src/state/sendTransition";
import { UserMessageBubble } from "../src/features/UserMessageBubble";

/** Each header side fits two 44 pt buttons, so the title stays centred. */
const HEADER_SIDE = 96;

/** Rows in Continue. */
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

function HomeScreen() {
  const app = useApp();
  const draft = useDraft();
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
  const connected = app.status === "open";
  // The daemon reports no user name, only the computer's ("Ada's MacBook"): the first name comes from that.
  const computer = app.environments.find((e) => e.id === app.activeId)?.name;
  const name = useMemo(() => ownerFirstName(computer), [computer]);
  // Home works in the active space: a draft project from another space gives way to this one's first.
  const spaceProjects = useSpaceProjects();
  const project =
    spaceProjects.find((p) => p.id === draft.projectId) ??
    spaceProjects.find((p) => !isFreeChatProject(p.id)) ??
    spaceProjects[0];
  const workspaceLabel = draft.worktree ? "Worktree" : "This checkout";
  const recent = useMemo(() => continueThreads(app.threads, project?.id), [app.threads, project?.id]);
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
  const pickup = connected && !outgoing && recent.length > 0;
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
        // 44 pt targets on an 8 pt grid: Threads leads, the computer (a switcher)
        // centres, Tasks and Notes trail. Equal side columns keep the title centred.
        // Settings lives on the Threads screen.
        <View
          style={{
            paddingTop: insets.top + space.xs,
            paddingHorizontal: space.sm,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <View style={{ flex: 1, minWidth: HEADER_SIDE, alignItems: "flex-start" }}>
            <IconButton
              name="list.bullet"
              label="Threads"
              onPress={() => router.push("/library")}
            />
          </View>
          <View style={{ flexShrink: 1, alignItems: "center" }}>
            <ComputerSwitcher />
          </View>
          <View style={{ flex: 1, minWidth: HEADER_SIDE, flexDirection: "row", justifyContent: "flex-end", gap: space.sm }}>
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
            {/* The space Home works in, always shown so New space and Manage spaces stay one tap away; switching refills Continue and the project chip. */}
            {connected && (
              <View style={{ alignSelf: "flex-start", marginBottom: space.md }}>
                <SpaceSwitcher compact always />
              </View>
            )}
            <T variant="largeTitle" accessibilityRole="header">
              {connected ? (name ? `What should we work on, ${name}?` : "What should we work on?") : "What are we building?"}
            </T>
            {!connected && (
              <T variant="subhead" tone="secondary" style={{ marginTop: space.sm, maxWidth: 320 }}>
                Work with your coding agents from anywhere.
              </T>
            )}
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
