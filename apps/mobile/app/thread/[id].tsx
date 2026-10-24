import { createHistoryPagingGate, HISTORY_PREFETCH_SCREENS } from "../../../../packages/kybern-client/src/historyPaging";
import { isCoordinatorThread } from "../../../../packages/kybern-client/src/coordinator";
import { canSteer } from "../../../../packages/kybern-client/src/steering";
import { isSubagentThread, subagentThreadPhase } from "../../../../packages/kybern-client/src/subagents";
import { ChatFileContext } from "../../src/state/chatFileContext";
import { randomUUID } from "expo-crypto";
import {
  LegendList,
  useViewability,
  type LegendListRef,
} from "@legendapp/list/react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, FadeOut, useSharedValue } from "react-native-reanimated";
import { ApprovalPanel, AsyncQuestions } from "../../src/features/Approvals";
import { Composer } from "../../src/features/Composer";
import { InspectorColumn } from "../../src/features/Inspector";
import { TranscriptBlock } from "../../src/features/Transcript";
import { WorkspaceMenu } from "../../src/features/WorkspaceMenu";
import { AgentsCapsule, openAgents, useAgents } from "../../src/features/AgentsSheet";
import { agentsCapsuleLabel } from "../../src/state/agents";
import { HeldMessages } from "../../src/features/HeldMessages";
import { ChildThreadBar } from "../../src/features/ChildThreadBar";
import { QueuedCapsule } from "../../src/features/QueuedPrompts";
import { StatusStrip } from "../../src/features/ThreadStatus";
import { useLayout } from "../../src/state/layout";
import {
  errorText,
  loadThread,
  ensureThread,
  loadEarlier,
  newChats,
  refresh,
  rpc,
  useApp,
  useNewChat,
  useThread,
} from "../../src/state/runtime";
import { NEW_CHAT_FAILED, type NewChat } from "../../../../packages/kybern-client/src/newChat";
import { partToken } from "../../../../packages/kybern-client/src/composerTokens";
import { newThreadId } from "../../src/state/ids";
import {
  createTurnRows,
  workDuration,
  type TurnRow,
} from "../../src/state/turnRows";
import type { ContentPart, Thread, UserMessage } from "../../src/state/protocol";
import { isInlinePart } from "../../src/state/inlineMessage";
import { DURATION } from "../../src/components/liquid/motion";
import { ChromeBar, ChromeProvider, useChromeInsets } from "../../src/ui/ChromeBar";
import {
  Empty,
  ErrorBanner,
  Icon,
  IconButton,
  T,
  Tap,
  styles,
} from "../../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../../src/ui/theme";
import { Working } from "../../src/ui/Working";
import { useSendTransition } from "../../src/components/liquid/SendTransition";
import { createOutgoingProjection } from "../../src/state/sendTransition";

const followOptions = { animated: false };
const anchorOptions = { data: true, size: true };
const viewabilityConfig = { id: "transcript", itemVisiblePercentThreshold: 1 };
const rowKey = (row: TurnRow) => row.key;
const rowType = (row: TurnRow) =>
  row.kind === "block" ? row.block.kind : "work";
const TranscriptRow = memo(function TranscriptRow({
  row,
  threadId,
  focused,
  expansions,
  onToggleWork,
}: {
  row: TurnRow;
  threadId: string;
  focused: boolean;
  expansions: Map<string, boolean>;
  onToggleWork: (turnId: string) => void;
}) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  useViewability(
    useCallback((token) => setVisible(token.isViewable), []),
    "transcript",
  );
  if (row.kind === "work") {
    return (
      <View
        style={{
          marginBottom: 12,
        }}
      >
        <Tap
          label={`${row.expanded ? "Hide" : "Show"} work. ${row.label ?? `Worked for ${workDuration(row.durationMs)}`}`}
          expanded={row.expanded}
          onPress={() => onToggleWork(row.turnId)}
          style={[styles.line, { gap: 8, paddingVertical: 8 }]}
        >
          <Icon name="hammer" size={14} color={colors.secondary} />
          <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
            {row.label ?? `Worked for ${workDuration(row.durationMs)}`}
          </T>
          <Icon
            name={row.expanded ? "chevron.up" : "chevron.down"}
            size={11}
            color={colors.muted}
          />
        </Tap>
      </View>
    );
  }
  return (
    <View
      style={
        row.nested
          ? {
              marginStart: 7,
              paddingStart: 14,
              borderStartWidth: 1,
              borderColor: colors.line,
              paddingBottom: 8,
            }
          : undefined
      }
    >
      <TranscriptBlock
        block={row.block}
        threadId={threadId}
        active={focused && visible}
        expansions={expansions}
        grouped
        thinking={row.thinking}
      />
    </View>
  );
});

const messageText = (message: UserMessage) =>
  message.parts.filter((part) => part.type === "text" || isInlinePart(part)).map((part) => (part.type === "text" ? part.text : partToken(part) ?? "")).join("");
/** A message's images and files, which go back to the composer's tray rather than its text. */
const messageAttachments = (message: UserMessage) => message.parts.filter((part) => part.type !== "text" && !isInlinePart(part));

/** A new chat whose create failed: the message stays above, with Try again (same thread id) and Edit. */
function NewChatFailed({ chat, onEdit }: { chat: NewChat; onEdit: () => void }) {
  return (
    <View>
      <ErrorBanner
        error={`Not sent. ${chat.error || NEW_CHAT_FAILED}`}
        onRetry={() => void newChats.retry(chat.threadId)}
      />
      <Tap label="Edit message" onPress={onEdit} style={{ alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 16 }}>
        <T variant="label" tone="secondary">Edit message</T>
      </Tap>
    </View>
  );
}

/** The topmost known ancestor. A broken chain ends at the last parent id the daemon reported. */
function mainConversation(thread: Thread, threads: readonly Thread[]): { id: string; title?: string } | null {
  const byId = new Map(threads.map((item) => [item.id, item]));
  const seen = new Set<string>([thread.id]);
  let id = thread.parent_thread_id ?? null;
  let found: { id: string; title?: string } | null = null;
  while (id && !seen.has(id)) {
    seen.add(id);
    const parent = byId.get(id);
    found = { id, title: parent?.title };
    id = parent?.parent_thread_id ?? null;
  }
  return found;
}

/**
 * Title + subtitle (or, for a thread another thread started, a breadcrumb back to the
 * main conversation), with a chevron that says the title opens the thread's details.
 */
function ThreadHeader({ thread, threadId }: { thread?: Thread | null; threadId: string }) {
  const app = useApp();
  const { colors } = useTheme();
  const { regular, sidebarOpen, toggleSidebar, inspectorOpen, inspectorTab, toggleInspector } = useLayout();
  const project = app.projects.find((p) => p.id === thread?.project_id);
  const main = thread?.parent_thread_id ? mainConversation(thread, app.threads) : null;
  const subtitle = [project?.name ?? "Workspace", thread?.worktree?.branch].filter(Boolean).join(" · ");
  const openDetails = () => router.push({ pathname: "/workspace", params: { threadId, tab: "More" } });
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.sm, paddingVertical: 6 }}>
      {regular ? (
        !sidebarOpen ? <IconButton name="sidebar.left" label="Show sidebar" onPress={toggleSidebar} /> : null
      ) : (
        <IconButton
          name="chevron.left"
          label="Back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        />
      )}
      <View style={{ flex: 1, paddingHorizontal: space.xs }}>
        <Tap
          label={`${thread?.title || "New thread"}. Open thread details`}
          feedback="none"
          onPress={openDetails}
          style={{ minHeight: main ? 24 : 44, alignItems: "flex-start" }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "100%" }}>
            <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
              {thread?.title || "New thread"}
            </T>
            <Icon name="chevron.down" size={10} color={colors.muted} />
          </View>
          {!main && (
            <T variant="footnote" tone="secondary" numberOfLines={1}>
              {subtitle}
            </T>
          )}
        </Tap>
        {main && (
          <Tap
            label={`Back to main conversation${main.title ? `, ${main.title}` : ""}`}
            feedback="none"
            hitSlop={{ top: 4, bottom: 8 }}
            onPress={() => router.dismissTo({ pathname: "/thread/[id]", params: { id: main.id } })}
            style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minHeight: 20, alignSelf: "flex-start" }}
          >
            <Icon name="arrow.turn.up.left" size={12} color={colors.accent} />
            <T variant="footnote" tone="accent" numberOfLines={1} style={{ flexShrink: 1 }}>
              {main.title || "Main conversation"}
            </T>
          </Tap>
        )}
      </View>
      {isCoordinatorThread(thread) && thread && (
        <IconButton
          name="folder"
          label="Project brief, setup and memory"
          onPress={() =>
            router.push({ pathname: "/project-space", params: { projectId: thread.coordinator_project_id! } })
          }
        />
      )}
      {regular && (
        <IconButton
          name="sidebar.right"
          label={inspectorOpen ? "Hide inspector" : "Show inspector"}
          color={inspectorOpen ? colors.accent : undefined}
          onPress={() => toggleInspector(inspectorTab)}
        />
      )}
      <WorkspaceMenu thread={thread} />
    </View>
  );
}

/** The only floating control: back to the end of the conversation. */
function JumpToLatest({ bottom, onPress }: { bottom: number; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.duration(DURATION.enter)}
      exiting={FadeOut.duration(DURATION.exit)}
      pointerEvents="box-none"
      style={{ position: "absolute", start: 0, end: 0, bottom: bottom + space.md, alignItems: "center" }}
    >
      <Tap
        label="Jump to latest message"
        onPress={onPress}
        hitSlop={4}
        style={{
          width: 36,
          height: 36,
          minHeight: 36,
          minWidth: 36,
          alignItems: "center",
          borderRadius: radius.full,
          backgroundColor: colors.raised,
          borderWidth: 0.5,
          borderColor: colors.line,
          boxShadow: "0 2px 10px #00000026",
        }}
      >
        <Icon name="arrow.down" size={16} />
      </Tap>
    </Animated.View>
  );
}

export default function ThreadScreen() {
  return (
    <ChromeProvider>
      <ThreadScreenBody />
    </ChromeProvider>
  );
}

function ThreadScreenBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const snapshot = useThread(id);
  const sendMotion = useSendTransition();
  const outgoing =
    sendMotion.outgoing?.threadId === id ? sendMotion.outgoing : null;
  const { colors } = useTheme();
  const { regular, openInspector } = useLayout();
  const { width } = useWindowDimensions();
  const chrome = useChromeInsets();
  const scrollY = useSharedValue(0);
  const [error, setError] = useState("");
  const [away, setAway] = useState(false);
  const [focused, setFocused] = useState(true);
  const [following, setFollowing] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const expansions = useRef(new Map<string, boolean>()).current;
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const projectRows = useMemo(() => createTurnRows(), [id]);
  const baseRows = useMemo(
    () => projectRows(snapshot.blocks, expandedTurns),
    [projectRows, snapshot.blocks, expandedTurns],
  );
  const projectOutgoing = useMemo(() => createOutgoingProjection(), [id]);
  const outgoingRows = useMemo(
    () => projectOutgoing(baseRows, outgoing),
    [projectOutgoing, baseRows, outgoing],
  );
  const rows = outgoingRows.rows;
  useEffect(() => {
    if (outgoing && outgoingRows.received) sendMotion.received(outgoing.id);
  }, [outgoing?.id, outgoingRows.received, sendMotion.received]);
  const list = useRef<LegendListRef>(null);
  const userScrolled = useRef(false);
  const historyGate = useMemo(() => createHistoryPagingGate(), [id]);
  const scrollGeometry = useRef({ distance: Infinity, height: 0 });
  const nearEnd = useRef(true);
  useEffect(() => {
    setFollowing(true);
    setAway(false);
    userScrolled.current = false;
    expansions.clear();
    setExpandedTurns(new Set());
  }, [id, expansions]);
  const toggleWork = useCallback((turnId: string) => {
    userScrolled.current = true;
    setFollowing(false);
    setExpandedTurns((previous) => {
      const next = new Set(previous);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);
  const thread = app.threads.find((t) => t.id === id) ?? snapshot.thread;
  const chat = useNewChat(id);
  const [editPrompt, setEditPrompt] = useState("");
  const [editAttachments, setEditAttachments] = useState<ContentPart[] | undefined>(undefined);
  // The daemon made this chat under its own id (an older daemon ignores ours): follow it.
  useEffect(() => {
    if (chat?.adoptedId) router.replace({ pathname: "/thread/[id]", params: { id: chat.adoptedId } });
  }, [chat?.adoptedId]);
  const fileContext = useMemo(() => ({ threadId: id, projectId: thread?.project_id }), [id, thread?.project_id]);
  const queued = app.queue.filter((q) => q.thread_id === id);
  const agents = useAgents(thread, snapshot.tasks, { active: focused });
  const capsule = agentsCapsuleLabel(agents);
  const subagent = isSubagentThread(thread);
  const subagentWorking = !!thread && subagent && subagentThreadPhase(thread) === "working";
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (app.status === "open")
        void ensureThread(id).catch((e) => setError(errorText(e)));
      return () => setFocused(false);
    }, [id, app.status]),
  );
  const stop = useCallback(() => {
    void rpc("threads.interrupt", { thread_id: id }).catch((e) =>
      setError(errorText(e)),
    );
  }, [id]);
  const renderItem = useCallback(
    ({ item }: { item: TurnRow }) => (
      <TranscriptRow
        row={item}
        threadId={id}
        focused={focused}
        expansions={expansions}
        onToggleWork={toggleWork}
      />
    ),
    [id, focused, expansions, toggleWork],
  );
  const jump = useCallback(() => {
    setFollowing(true);
    userScrolled.current = false;
    setAway(false);
    list.current?.scrollToEnd({ animated: false });
  }, []);
  useEffect(() => {
    if (outgoing) jump();
  }, [outgoing?.id, jump]);
  // When a turn ends, completed work folds into a single row and the iOS list can
  // strand its native scroll anchor at the top. If the reader was following the
  // output, re-pin them to the end so they land on the final answer, not row one.
  const wasRunning = useRef(false);
  useEffect(() => {
    const running =
      thread?.status === "running" || thread?.status === "awaiting-approval";
    if (wasRunning.current && !running && following) jump();
    wasRunning.current = running;
  }, [thread?.status, following, jump]);
  // Rows can still arrive after that (the outside-change warning follows the turn's
  // end); keep a following reader on them instead of leaving them under the bar.
  const lastRow = rows.length ? rowKey(rows[rows.length - 1]!) : "";
  useEffect(() => {
    if (lastRow && following && !wasRunning.current) jump();
  }, [lastRow]);
  // The bottom bar grew or shrank (a status strip, a held message): a following
  // reader stays on the last line instead of having it slide under the bar.
  useEffect(() => {
    if (following) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }));
  }, [chrome.bottom]);
  const steeringAttempt = useRef<{ signature: string; id: string } | null>(
    null,
  );
  const steer = useCallback(
    async (message: UserMessage) => {
      const signature = JSON.stringify([id, message]);
      if (steeringAttempt.current?.signature !== signature)
        steeringAttempt.current = { signature, id: randomUUID() };
      const receipt = await rpc("threads.steer", {
        thread_id: id,
        id: steeringAttempt.current.id,
        message,
      });
      steeringAttempt.current = null;
      jump();
      return { threadId: id, messageId: receipt.message_id };
    },
    [id, jump],
  );
  const subagentAttempt = useRef<{ signature: string; id: string } | null>(null);
  const send = useCallback(
    async (message: UserMessage) => {
      // A provider subagent takes messages at its next tool call, not as a turn.
      if (subagent) {
        const signature = JSON.stringify([id, message]);
        if (subagentAttempt.current?.signature !== signature)
          subagentAttempt.current = { signature, id: randomUUID() };
        const result = await rpc("subagents.send", { thread_id: id, id: subagentAttempt.current.id, message });
        if (result.status === "failed")
          throw new Error(result.error ?? "Not delivered: the subagent has finished. Send it to the main conversation instead.");
        subagentAttempt.current = null;
        return;
      }
      // A new chat the daemon has not made yet: an edited first message goes through its create
      // again (same thread id), and a follow-up waits for the create to finish first.
      if (newChats.uncreated(id)) {
        if (newChats.get(id)!.state === "failed") {
          const messageId = newThreadId();
          const done = await newChats.retry(id, { message, messageId });
          if (done?.state === "failed") throw new Error(done.error);
          return { threadId: id, messageId };
        }
        const done = await newChats.retry(id);
        if (done?.state === "failed") throw new Error(done.error);
      }
      if (
        thread?.status === "running" ||
        thread?.status === "awaiting-approval"
      ) {
        await rpc("queue.add", { thread_id: id, id: randomUUID(), message });
        await refresh();
      } else {
        const receipt = await rpc("threads.send", { thread_id: id, message });
        return { threadId: id, messageId: receipt.message_id };
      }
      jump();
    },
    [id, thread?.status, jump, subagent],
  );
  const earlier = () => {
    setFollowing(false);
    setHistoryError("");
    void loadEarlier(id).catch((e) => setHistoryError(errorText(e)));
  };
  const prefetchEarlier = () => {
    const geometry = scrollGeometry.current;
    if (historyGate.claim(snapshot.nextBeforeSeq, geometry.distance, geometry.height,
      focused && userScrolled.current && !snapshot.loadingEarlier && !historyError && app.status === "open")) earlier();
  };
  const side = gutter(width);
  // Stable identities so a re-render from a sidebar/inspector toggle does not
  // hand the list new style objects and reset its scroll offset.
  const listContentStyle = useMemo(
    () => ({
      paddingHorizontal: side,
      paddingBottom: chrome.bottom + space.lg,
      paddingTop: chrome.top + space.lg,
      width: "100%" as const,
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: "center" as const,
    }),
    [chrome.top, chrome.bottom, side],
  );
  const listIndicatorInsets = useMemo(
    () => ({ top: chrome.top, bottom: chrome.bottom }),
    [chrome.top, chrome.bottom],
  );
  const running = thread?.status === "running" || thread?.status === "awaiting-approval";
  return (
    <ChatFileContext value={fileContext}><KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}
    >
      <View style={{ flex: 1 }}>
        {!snapshot.loaded ? (
          <View
            style={{ paddingTop: chrome.top + 50, paddingHorizontal: side }}
          >
            <Working label="Loading conversation" active={focused} />
            <ErrorBanner
              error={error}
              onRetry={() => {
                void loadThread(id).catch((e) => setError(errorText(e)));
              }}
            />
          </View>
        ) : (
          <LegendList
            key={id}
            ref={list}
            data={rows}
            keyExtractor={rowKey}
            getItemType={rowType}
            renderItem={renderItem}
            extraData={focused}
            viewabilityConfig={viewabilityConfig}
            initialScrollAtEnd
            estimatedItemSize={170}
            drawDistance={400}
            recycleItems={false}
            maintainScrollAtEnd={following ? followOptions : false}
            maintainScrollAtEndThreshold={0.05}
            // iOS keeps a native anchor across mounting transactions. Toggling
            // it during a drag changes native child retention and can reuse a
            // stale virtual-list anchor, sending the scroll offset to the top.
            maintainVisibleContentPosition={
              Platform.OS === "ios" || !following ? anchorOptions : false
            }
            contentInsetAdjustmentBehavior="never"
            scrollIndicatorInsets={listIndicatorInsets}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={listContentStyle}
            onScrollBeginDrag={() => {
              userScrolled.current = true;
              setFollowing(false);
              prefetchEarlier();
            }}
            onScrollEndDrag={() => {
              setFollowing(nearEnd.current);
            }}
            onMomentumScrollEnd={() => {
              setFollowing(nearEnd.current);
            }}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              scrollY.set(contentOffset.y);
              scrollGeometry.current = { distance: contentOffset.y, height: layoutMeasurement.height };
              if (!userScrolled.current) return;
              prefetchEarlier();
              const near =
                contentSize.height -
                  contentOffset.y -
                  layoutMeasurement.height <
                24;
              nearEnd.current = near;
              if (!near) setFollowing(false);
              setAway(!near);
            }}
            scrollEventThrottle={16}
            onLayout={(event) => { scrollGeometry.current.height = event.nativeEvent.layout.height; }}
            onStartReached={({ distanceFromStart }) => {
              scrollGeometry.current.distance = distanceFromStart;
              prefetchEarlier();
            }}
            onStartReachedThreshold={HISTORY_PREFETCH_SCREENS}
            ListHeaderComponent={
              snapshot.nextBeforeSeq !== null ? (
                <View style={{ paddingVertical: 12, minHeight: 44 }}>
                  {historyError ? <ErrorBanner error={historyError} onRetry={earlier} /> :
                    snapshot.loadingEarlier ? (
                      <T variant="footnote" tone="secondary" accessibilityLiveRegion="polite">
                        Loading earlier messages…
                      </T>
                    ) : null}
                </View>
              ) : null
            }
            ListEmptyComponent={
              <Empty
                title="A clean slate."
                detail="Tell your agent what you want to work on."
              />
            }
            ListFooterComponent={
              <View style={{ gap: 16 }}>
                {chat?.state === "failed" && (
                  <NewChatFailed chat={chat} onEdit={() => { setEditPrompt(messageText(chat.message)); setEditAttachments(messageAttachments(chat.message)); }} />
                )}
                <ErrorBanner
                  error={error}
                  onRetry={() => {
                    setError("");
                    void loadThread(id).catch((e) => setError(errorText(e)));
                  }}
                />
                {snapshot.pendingApprovals
                  .filter(
                    (a) =>
                      !snapshot.blocks.some(
                        (b) =>
                          b.kind === "approval" && b.approval.id === a.id,
                      ),
                  )
                  .map((a) => (
                    <ApprovalPanel key={a.id} approval={a} />
                  ))}
                {snapshot.pendingQuestions?.map((q) => (
                  <AsyncQuestions key={q.id} request={q} threadId={id} />
                ))}
              </View>
            }
          />
        )}
        <ChromeBar edge="top" scrollY={scrollY}>
          <ThreadHeader thread={thread} threadId={id} />
          {app.status !== "open" && (
            <View style={{ paddingHorizontal: side, paddingBottom: space.sm }}>
              <ErrorBanner
                error={
                  app.status === "connecting" || app.status === "reconnecting"
                    ? "Reconnecting to your computer…"
                    : "Your computer is disconnected. Reconnect in settings."
                }
                onRetry={() => router.push("/settings")}
              />
            </View>
          )}
        </ChromeBar>
        {away && <JumpToLatest bottom={chrome.bottom} onPress={jump} />}
        <ChromeBar edge="bottom" contentUnder={away}>
          <View
            style={{
              width: "100%",
              maxWidth: CONTENT_MAX_WIDTH,
              alignSelf: "center",
              paddingTop: space.sm,
            }}
          >
            <View style={{ paddingHorizontal: side, gap: space.sm }}>
              <HeldMessages thread={thread} senders={agents.children} />
              <ChildThreadBar thread={thread} />
              {running && !subagent && (
                <StatusStrip
                  threadId={id}
                  status={
                    chat?.worktree && chat.state === "creating"
                      ? "preparing"
                      : snapshot.pendingApprovals.length || thread?.status === "awaiting-approval"
                        ? "approval"
                        : snapshot.pendingQuestions?.length
                          ? "question"
                          : "working"
                  }
                  blocks={snapshot.blocks}
                  active={focused}
                />
              )}
              {(capsule || queued.length > 0) && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  {capsule && (
                    <AgentsCapsule
                      label={capsule}
                      running={agents.runningAgents + agents.runningProcesses > 0}
                      onPress={() => (regular ? openInspector("tasks") : openAgents(id))}
                    />
                  )}
                  <View style={{ flex: 1 }} />
                  {queued.length > 0 && <QueuedCapsule threadId={id} count={queued.length} />}
                </View>
              )}
            </View>
            <Composer
              thread={thread}
              onSteer={thread && !subagent && canSteer(thread.provider) ? steer : undefined}
              disabled={
                app.status !== "open" ||
                !snapshot.loaded ||
                thread?.status === "archived" ||
                (subagent && !subagentWorking)
              }
              placeholder={
                subagent
                  ? subagentWorking
                    ? "Message this subagent…"
                    : "This subagent has finished"
                  : undefined
              }
              onStop={subagent ? undefined : stop}
              onSend={send}
              prompt={editPrompt}
              promptAttachments={editAttachments}
              onPromptConsumed={() => { setEditPrompt(""); setEditAttachments(undefined); }}
            />
          </View>
        </ChromeBar>
      </View>
      <InspectorColumn threadId={id} />
    </KeyboardAvoidingView></ChatFileContext>
  );
}
