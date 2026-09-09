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
import { View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalPanel, AsyncQuestions } from "../../src/features/Approvals";
import { Composer } from "../../src/features/Composer";
import { TranscriptBlock } from "../../src/features/Transcript";
import { WorkspaceMenu, WorkspacePill } from "../../src/features/WorkspaceMenu";
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
          borderBottomWidth: 1,
          borderColor: colors.line,
        }}
      >
        <Tap
          label={`Worked for ${workDuration(row.durationMs)}. ${row.expanded ? "Hide" : "Show"} work`}
          expanded={row.expanded}
          onPress={() => onToggleWork(row.turnId)}
          style={[styles.line, { gap: 8, paddingVertical: 8 }]}
        >
          <Icon name="hammer" size={14} color={colors.secondary} />
          <T variant="caption" tone="secondary" style={{ flex: 1 }}>
            Worked for {workDuration(row.durationMs)}
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
  const { colors, dark } = useTheme();
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
  const rows = useMemo(
    () => projectRows(snapshot.blocks, expandedTurns),
    [projectRows, snapshot.blocks, expandedTurns],
  );
  const list = useRef<LegendListRef>(null);
  const userScrolled = useRef(false);
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
  const steeringAttempt = useRef<{ signature: string; id: string } | null>(null);
  const steer = useCallback(async (message: UserMessage) => {
    const signature = JSON.stringify([id, message]);
    if (steeringAttempt.current?.signature !== signature) steeringAttempt.current = { signature, id: randomUUID() };
    await rpc("threads.steer", { thread_id: id, id: steeringAttempt.current.id, message });
    steeringAttempt.current = null;
    jump();
  }, [id, jump]);
  const send = useCallback(
    async (message: UserMessage) => {
      if (
        thread?.status === "running" ||
        thread?.status === "awaiting-approval"
      ) {
        await rpc("queue.add", { thread_id: id, id: randomUUID(), message });
        await refresh();
      } else await rpc("threads.send", { thread_id: id, message });
      jump();
    },
    [id, thread?.status, jump],
  );
  const earlier = () => {
    setFollowing(false);
    setHistoryError("");
    void loadEarlier(id).catch((e) => setHistoryError(errorText(e)));
  };
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
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
              maintainVisibleContentPosition={following ? false : anchorOptions}
              contentInsetAdjustmentBehavior="never"
              scrollIndicatorInsets={{
                top: headerHeight,
                bottom: footerHeight,
              }}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: 24,
                paddingBottom: footerHeight + 16,
                paddingTop: headerHeight + 16,
                width: "100%",
                maxWidth: 760,
                alignSelf: "center",
              }}
              onScrollBeginDrag={() => {
                userScrolled.current = true;
                setFollowing(false);
              }}
              onScrollEndDrag={() => {
                setFollowing(nearEnd.current);
              }}
              onMomentumScrollEnd={() => {
                setFollowing(nearEnd.current);
              }}
              onScroll={(e) => {
                if (!userScrolled.current) return;
                const { contentOffset, contentSize, layoutMeasurement } =
                  e.nativeEvent;
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
              onStartReached={() => {
                if (
                  userScrolled.current &&
                  snapshot.nextBeforeSeq !== null &&
                  !historyError
                )
                  earlier();
              }}
              onStartReachedThreshold={0.3}
              ListHeaderComponent={
                snapshot.nextBeforeSeq !== null ? (
                  <View style={{ paddingVertical: 12 }}>
                    <Tap
                      label="Load earlier messages"
                      disabled={snapshot.loadingEarlier}
                      onPress={earlier}
                    >
                      <T variant="caption" tone="secondary">
                        {snapshot.loadingEarlier
                          ? "Loading earlier messages…"
                          : "Load earlier messages"}
                      </T>
                    </Tap>
                    <ErrorBanner error={historyError} onRetry={earlier} />
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
            <IconButton
              name="chevron.left"
              label="Back"
              onPress={() =>
                router.canGoBack() ? router.back() : router.replace("/")
              }
            />
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
              onSteer={thread?.provider.kind === "codex" ? steer : undefined}
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
    </KeyboardAvoidingView>
  );
}
