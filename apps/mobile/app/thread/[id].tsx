import { createHistoryPagingGate, HISTORY_PREFETCH_SCREENS } from "../../../../packages/kybern-client/src/historyPaging";
import { ChatFileContext } from "../../src/state/chatFileContext";
import { QueuedPrompts } from "../../src/features/QueuedPrompts";
import { BlurTargetView } from "expo-blur";
import { ProgressiveBlur } from "../../src/components/ui/progressive-blur";
import { randomUUID } from "expo-crypto";
import {
  LegendList,
  useViewability,
  type LegendListRef,
} from "@legendapp/list/react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalPanel, AsyncQuestions } from "../../src/features/Approvals";
import { Composer } from "../../src/features/Composer";
import { InspectorColumn } from "../../src/features/Inspector";
import { TranscriptBlock } from "../../src/features/Transcript";
import { WorkspaceMenu, WorkspacePill } from "../../src/features/WorkspaceMenu";
import { useLayout } from "../../src/state/layout";
import {
  errorText,
  loadThread,
  ensureThread,
  loadEarlier,
  refresh,
  rpc,
  useApp,
  useThread,
  taskActive,
} from "../../src/state/runtime";
import {
  createTurnRows,
  workDuration,
  type TurnRow,
} from "../../src/state/turnRows";
import type { UserMessage } from "../../src/state/protocol";
import {
  Empty,
  ErrorBanner,
  Icon,
  IconButton,
  T,
  Tap,
  styles,
} from "../../src/ui/primitives";
import { useTheme } from "../../src/ui/theme";
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
          <T variant="caption" tone="secondary" style={{ flex: 1 }}>
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
      />
    </View>
  );
});

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const snapshot = useThread(id);
  const sendMotion = useSendTransition();
  const outgoing =
    sendMotion.outgoing?.threadId === id ? sendMotion.outgoing : null;
  const { colors, dark } = useTheme();
  const {
    regular,
    sidebarOpen,
    toggleSidebar,
    inspectorOpen,
    inspectorTab,
    toggleInspector,
  } = useLayout();
  const insets = useSafeAreaInsets();
  const blurTarget = useRef<View>(null);
  const [footerHeight, setFooterHeight] = useState(230);
  const [composerHeight, setComposerHeight] = useState(150);
  const [headerHeight, setHeaderHeight] = useState(insets.top + 64);
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
  const fileContext = useMemo(() => ({ threadId: id, projectId: thread?.project_id }), [id, thread?.project_id]);
  const project = app.projects.find((p) => p.id === thread?.project_id);
  const queued = app.queue.filter((q) => q.thread_id === id);
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
  const send = useCallback(
    async (message: UserMessage) => {
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
    [id, thread?.status, jump],
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
  // Stable identities so a re-render from a sidebar/inspector toggle does not
  // hand the list new style objects and reset its scroll offset.
  const listContentStyle = useMemo(
    () => ({
      paddingHorizontal: 24,
      paddingBottom: footerHeight + 16,
      paddingTop: headerHeight + 16,
      width: "100%" as const,
      maxWidth: 760,
      alignSelf: "center" as const,
    }),
    [headerHeight, footerHeight],
  );
  const listIndicatorInsets = useMemo(
    () => ({ top: headerHeight, bottom: footerHeight }),
    [headerHeight, footerHeight],
  );
  return (
    <ChatFileContext value={fileContext}><KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, flexDirection: "row", backgroundColor: colors.background }}
    >
      <View style={{ flex: 1 }}>
        <BlurTargetView ref={blurTarget} style={{ flex: 1 }}>
          {!snapshot.loaded ? (
            <View
              style={{ paddingTop: headerHeight + 50, paddingHorizontal: 24 }}
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
                      <T variant="caption" tone="secondary" accessibilityLiveRegion="polite">
                        {snapshot.loadingEarlier ? "Loading earlier messages…" : "Scroll up for earlier messages"}
                      </T>}
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
                  {(thread?.status === "running" ||
                    thread?.status === "awaiting-approval") && (
                    <View style={{ paddingVertical: 15 }}>
                      <Working
                        label={
                          snapshot.pendingApprovals.length
                            ? "Waiting for your approval"
                            : "Working on it"
                        }
                        active={focused}
                      />
                    </View>
                  )}
                </View>
              }
            />
          )}
        </BlurTargetView>
        <ProgressiveBlur
          key={`top-${snapshot.loaded}`}
          edge="top"
          height={headerHeight + 24}
          fadeStart={Math.max(0, headerHeight - 24)}
          layers={3}
          intensity={90}
          tint={dark ? "dark" : "light"}
          blurTarget={blurTarget}
          style={{ top: 0 }}
        />
        <ProgressiveBlur
          key={`bottom-${snapshot.loaded}`}
          edge="bottom"
          height={Math.max(12, insets.bottom) + composerHeight * 0.25}
          fadeStart={Math.max(0, insets.bottom - 12)}
          tint={dark ? "dark" : "light"}
          blurTarget={blurTarget}
          style={{ bottom: 0 }}
        />
        <View
          pointerEvents="box-none"
          onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}
          style={{ position: "absolute", top: 0, left: 0, right: 0 }}
        >
          <View
            style={{
              paddingTop: insets.top + 6,
              paddingBottom: 8,
              paddingHorizontal: 12,
              ...styles.line,
              gap: 4,
            }}
          >
            {regular ? (
              !sidebarOpen ? (
                <IconButton
                  name="sidebar.left"
                  label="Show sidebar"
                  onPress={toggleSidebar}
                />
              ) : null
            ) : (
              <IconButton
                name="chevron.left"
                label="Back"
                onPress={() =>
                  router.canGoBack() ? router.back() : router.replace("/")
                }
              />
            )}
            <Tap
              label="Open thread settings"
              onPress={() =>
                router.push({
                  pathname: "/workspace",
                  params: { threadId: id, tab: "More" },
                })
              }
              style={{ flex: 1, paddingHorizontal: 5 }}
            >
              <T variant="label" numberOfLines={1}>
                {thread?.title || "New thread"}
              </T>
              <T variant="caption" tone="secondary" numberOfLines={1}>
                {project?.name ?? "Workspace"}
                {thread?.worktree ? ` · ${thread.worktree.branch}` : ""}
              </T>
            </Tap>
            {regular && (
              <IconButton
                name="sidebar.right"
                label={inspectorOpen ? "Hide inspector" : "Show inspector"}
                filled={inspectorOpen}
                onPress={() => toggleInspector(inspectorTab)}
              />
            )}
            <WorkspaceMenu thread={thread} />
          </View>
          {app.status !== "open" && (
            <View style={{ paddingHorizontal: 24 }}>
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
        </View>
        <View
          pointerEvents="box-none"
          onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
          style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}
        >
          <WorkspacePill
            threadId={id}
            activeTasks={snapshot.tasks.filter(taskActive).length}
            onJumpToLatest={away ? jump : undefined}
          />
          {queued.length > 0 && <QueuedPrompts items={queued} />}
          <View
            onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
          >
            <Composer
              thread={thread}
              onSteer={thread && ["codex", "pi"].includes(thread.provider.kind) ? steer : undefined}
              disabled={
                app.status !== "open" ||
                !snapshot.loaded ||
                thread?.status === "archived"
              }
              onStop={stop}
              onSend={send}
            />
          </View>
          <View style={{ height: Math.max(12, insets.bottom) }} />
        </View>
      </View>
      <InspectorColumn threadId={id} />
    </KeyboardAvoidingView></ChatFileContext>
  );
}
