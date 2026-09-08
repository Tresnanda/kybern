import { BlurTargetView } from "expo-blur";
import { ProgressiveBlur } from "../../src/components/ui/progressive-blur";
import { randomUUID } from "expo-crypto";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, View, type ViewToken } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApprovalPanel, AsyncQuestions } from "../../src/features/Approvals";
import { Composer } from "../../src/features/Composer";
import { TranscriptBlock } from "../../src/features/Transcript";
import { WorkspaceMenu, WorkspacePill } from "../../src/features/WorkspaceMenu";
import {
  errorText,
  loadThread,
  refresh,
  rpc,
  useApp,
  useThread,
  taskActive,
} from "../../src/state/runtime";
import { type Block } from "../../src/state/transcript";
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
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<Block>[] }) => {
      const next = new Set(viewableItems.map((item) => item.item.id));
      setVisible((previous) =>
        previous.size === next.size && [...next].every((id) => previous.has(id))
          ? previous
          : next,
      );
    },
    [],
  );
  const list = useRef<FlatList<Block>>(null);
  const following = useRef(true);
  const userScrolled = useRef(false);
  const dragging = useRef(false);
  const geometry = useRef({ content: 0, viewport: 0 });
  const followFrame = useRef<number | null>(null);
  const followEnd = () => {
    if (followFrame.current !== null) cancelAnimationFrame(followFrame.current);
    followFrame.current = requestAnimationFrame(() => {
      followFrame.current = null;
      if (following.current && !dragging.current)
        list.current?.scrollToOffset({
          offset: Math.max(
            0,
            geometry.current.content - geometry.current.viewport,
          ),
          animated: false,
        });
    });
  };
  useEffect(
    () => () => {
      if (followFrame.current !== null)
        cancelAnimationFrame(followFrame.current);
    },
    [],
  );
  const thread = app.threads.find((t) => t.id === id) ?? snapshot.thread;
  const project = app.projects.find((p) => p.id === thread?.project_id);
  const queued = app.queue.filter((q) => q.thread_id === id);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      if (app.status === "open")
        void loadThread(id).catch((e) => setError(errorText(e)));
      return () => setFocused(false);
    }, [id, app.status]),
  );
  async function stop() {
    try {
      await rpc("threads.interrupt", { thread_id: id });
    } catch (e) {
      setError(errorText(e));
    }
  }
  const renderItem = useCallback(
    ({ item }: { item: Block }) => (
      <TranscriptBlock
        block={item}
        threadId={id}
        active={focused && visible.has(item.id)}
      />
    ),
    [id, focused, visible],
  );
  const jump = () => {
    following.current = true;
    userScrolled.current = false;
    setAway(false);
    followEnd();
  };
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <View style={{ flex: 1 }}>
        <BlurTargetView ref={blurTarget} style={{ flex: 1 }}>
          <FlatList
            ref={list}
            data={snapshot.blocks}
            keyExtractor={(b) => `${b.kind}:${b.id}`}
            renderItem={renderItem}
            viewabilityConfig={viewabilityConfig}
            onViewableItemsChanged={onViewableItemsChanged}
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            windowSize={7}
            contentInsetAdjustmentBehavior="never"
            scrollIndicatorInsets={{ top: headerHeight, bottom: footerHeight }}
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
              dragging.current = true;
              following.current = false;
            }}
            onScrollEndDrag={() => {
              dragging.current = false;
            }}
            onMomentumScrollEnd={() => {
              dragging.current = false;
            }}
            onScroll={(e) => {
              if (!userScrolled.current) return;
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              const near =
                contentSize.height -
                  contentOffset.y -
                  layoutMeasurement.height <
                100;
              following.current = near;
              if (away === near) setAway(!near);
            }}
            scrollEventThrottle={100}
            onLayout={(e) => {
              geometry.current.viewport = e.nativeEvent.layout.height;
              if (following.current) followEnd();
            }}
            onContentSizeChange={(_, height) => {
              geometry.current.content = height;
              if (following.current) followEnd();
            }}
            ListEmptyComponent={
              !snapshot.loaded ? (
                <View style={{ paddingVertical: 50 }}>
                  <Working label="Loading conversation" active={focused} />
                </View>
              ) : (
                <Empty
                  title="A clean slate."
                  detail="Tell your agent what you want to work on."
                />
              )
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
                        (b) => b.kind === "approval" && b.approval.id === a.id,
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
        </BlurTargetView>
        <ProgressiveBlur
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
          {queued.length > 0 && (
            <View style={{ paddingHorizontal: 24, maxHeight: 110 }}>
              {queued.map((q) => (
                <View key={q.id} style={styles.spread}>
                  <T
                    variant="caption"
                    tone="secondary"
                    numberOfLines={1}
                    style={{ flex: 1 }}
                  >
                    Queued ·{" "}
                    {q.message.parts
                      .map((p) => (p.type === "text" ? p.text : `[${p.type}]`))
                      .join(" ")}
                  </T>
                  <IconButton
                    name="xmark"
                    label="Remove queued message"
                    onPress={() => {
                      void rpc("queue.remove", { thread_id: id, id: q.id })
                        .then(refresh)
                        .catch((e) => setError(errorText(e)));
                    }}
                  />
                </View>
              ))}
            </View>
          )}
          <View
            onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
          >
            <Composer
              thread={thread}
              disabled={
                app.status !== "open" ||
                !snapshot.loaded ||
                thread?.status === "archived"
              }
              onStop={() => void stop()}
              onSend={async (message) => {
                if (
                  thread?.status === "running" ||
                  thread?.status === "awaiting-approval"
                ) {
                  await rpc("queue.add", {
                    thread_id: id,
                    id: randomUUID(),
                    message,
                  });
                  await refresh();
                } else await rpc("threads.send", { thread_id: id, message });
                jump();
              }}
            />
          </View>
          <View style={{ height: Math.max(12, insets.bottom) }} />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
