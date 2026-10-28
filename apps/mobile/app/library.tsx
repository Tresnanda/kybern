import { attentionItems } from "../../../packages/kybern-client/src/threadAttention";
import Animated, { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { router } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, RefreshControl, View } from "react-native";
import { ThreadListRow, type ThreadRowContext } from "../src/features/ThreadRows";
import { SpaceSwitcher, useSpaceMenuItems } from "../src/features/Spaces";
import { useLayout } from "../src/state/layout";
import { attentionSignals, dismissAttention, useListState } from "../src/state/listState";
import { PROVIDER_DISPLAY_NAME, type Thread } from "../src/state/protocol";
import { errorText, refresh, threadHasActivity, useApp } from "../src/state/runtime";
import { currentSpaceId, useSpaces } from "../src/state/spaces";
import {
  DEFAULT_FILTER,
  emptyText,
  filterThreads,
  FILTERED_FIRST_PAGE,
  groupByProject,
  isFiltering,
  SECTION_PAGE,
  sectionWindow,
  threadAgents,
  threadRows,
  THREAD_SCOPES,
  type ThreadFilter,
  type ThreadRow,
} from "../src/state/threadList";
import { HeaderActions } from "../src/ui/ActionMenu";
import { ListRow, ListSeparator, SectionHeader } from "../src/ui/List";
import type { MenuItem } from "../src/ui/menuModel";
import { Button, Empty, ErrorBanner } from "../src/ui/primitives";
import { PullRefresh } from "../src/ui/PullRefresh";
import { ListSearch } from "../src/ui/Search";
import { Segmented } from "../src/ui/Segmented";
import { CONTENT_MAX_WIDTH, space, useTheme } from "../src/ui/theme";

type Item =
  | { kind: "header"; key: string; title: string; count?: number; projectId?: string; open?: boolean }
  | { kind: "row"; key: string; row: ThreadRow }
  | { kind: "more"; key: string; projectId: string; remaining: number };

/** Which project groups the reader folded, kept while the app runs. */
const foldedProjects: Record<string, boolean> = {};
/** How many "Show more" pages each project section revealed, kept the same way. */
const shownPages: Record<string, number> = {};

/** Hairline between two thread rows; the list gives the neighbours, no lookup needed. */
function Separator({ leadingItem, trailingItem }: { leadingItem?: Item; trailingItem?: Item }) {
  return leadingItem?.kind === "row" && trailingItem?.kind === "row" ? <ListSeparator leading /> : null;
}

/** "Show more" under a project's threads: the next page, or what is left. */
const ShowMoreRow = memo(function ShowMoreRow({ remaining, onPress }: { remaining: number; onPress: () => void }) {
  const next = Math.min(remaining, SECTION_PAGE);
  return (
    <ListRow
      title={`Show ${next} more`}
      subtitle={remaining > next ? `${remaining} hidden` : undefined}
      subtitleLines={1}
      leading="chevron.down"
      label={`Show ${next} more threads`}
      onPress={onPress}
    />
  );
});

export default function Library() {
  const app = useApp();
  const list = useListState();
  const spaces = useSpaces();
  const spaceId = currentSpaceId(spaces);
  const spaceMenu = useSpaceMenuItems();
  const { colors } = useTheme();
  const { regular } = useLayout();
  const [filter, setFilter] = useState<ThreadFilter>(DEFAULT_FILTER);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [folded, setFolded] = useState<Record<string, boolean>>(() => ({ ...foldedProjects }));
  const fold = useCallback((projectId: string, value: boolean) => {
    foldedProjects[projectId] = value;
    setFolded((old) => ({ ...old, [projectId]: value }));
  }, []);
  const [pages, setPages] = useState<Record<string, number>>(() => ({ ...shownPages }));
  const showMore = useCallback((projectId: string) => {
    shownPages[projectId] = (shownPages[projectId] ?? 0) + 1;
    setPages((old) => ({ ...old, [projectId]: shownPages[projectId] }));
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  // On a wide layout the persistent sidebar is the thread list; this route is
  // redundant, so bounce back to the detail instead of showing a duplicate.
  useEffect(() => {
    if (regular) router.replace("/");
  }, [regular]);

  const isWorking = useCallback((t: Thread) => threadHasActivity(t, app.activity), [app.activity]);
  const top = useMemo(
    () => filterThreads({ threads: app.threads, projects: app.projects, spaceId, filter, isWorking }),
    [app.threads, app.projects, spaceId, filter, isWorking],
  );
  const children = useMemo(() => Object.values(list.children), [list.children]);
  // Pinned first, then one foldable section per project in the user's project
  // order (as the iPad sidebar and the desktop do). A search or filter opens
  // every section so no match hides behind a fold.
  const items = useMemo<Item[]>(() => {
    const filtering = isFiltering(filter);
    const rowItems = (threads: readonly Thread[]) =>
      threadRows(threads, filter.archived ? [] : children, expanded, { now: Date.now() }).map(
        (row) => ({ kind: "row" as const, key: row.thread.id, row }),
      );
    const pinned = filtering ? [] : top.filter((t) => t.pinned);
    const out: Item[] = pinned.length ? [{ kind: "header", key: "h:pinned", title: "Pinned" }, ...rowItems(pinned)] : [];
    const rest = pinned.length ? top.filter((t) => !t.pinned) : top;
    for (const group of groupByProject(rest, app.projects, list.projectOrder)) {
      const open = filtering || !folded[group.projectId];
      out.push({
        kind: "header",
        key: `p:${group.projectId}`,
        title: group.name,
        count: group.threads.length,
        projectId: group.projectId,
        open,
      });
      if (open) {
        // Ten per section, then pages; a search still reaches every match.
        const { shown, remaining } = sectionWindow(
          group.threads.length,
          pages[group.projectId] ?? 0,
          filtering ? FILTERED_FIRST_PAGE : undefined,
        );
        out.push(...rowItems(group.threads.slice(0, shown)));
        if (remaining > 0)
          out.push({ kind: "more", key: `m:${group.projectId}`, projectId: group.projectId, remaining });
      }
    }
    return out;
  }, [top, children, expanded, filter, folded, pages, app.projects, list.projectOrder]);

  const spaceThreads = useMemo(
    () => filterThreads({ threads: app.threads, projects: app.projects, spaceId, filter: DEFAULT_FILTER, isWorking }),
    [app.threads, app.projects, spaceId, isWorking],
  );
  const attention = useMemo(() => attentionItems(spaceThreads, attentionSignals(list)), [spaceThreads, list]);
  const agents = useMemo(() => threadAgents(spaceThreads, filter.agent), [spaceThreads, filter.agent]);
  const agentName = filter.agent ? (PROVIDER_DISPLAY_NAME[filter.agent] ?? filter.agent) : undefined;

  const ctx = useMemo<ThreadRowContext>(
    () => ({
      variant: "list",
      projectName: (id) => app.projects.find((p) => p.id === id)?.name ?? "Free chat",
      onToggleChildren: (id, open) => setExpanded((value) => ({ ...value, [id]: open })),
      onError: setError,
    }),
    [app.projects],
  );

  const offset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.set(event.contentOffset.y);
    },
  });
  const refreshingRef = useRef(false);
  const reload = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await refresh();
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
      refreshingRef.current = false;
    }
  }, []);

  const menu: MenuItem[] = [
    ...spaceMenu,
    {
      title: "Agent",
      icon: "sparkles",
      subtitle: agentName ?? "All agents",
      children: [
        { title: "All agents", checked: !filter.agent, onPress: () => setFilter((f) => ({ ...f, agent: null })) },
        ...agents.map<MenuItem>((kind) => ({
          title: PROVIDER_DISPLAY_NAME[kind] ?? kind,
          checked: filter.agent === kind,
          onPress: () => setFilter((f) => ({ ...f, agent: kind })),
        })),
      ],
    },
    {
      title: "Show archived",
      icon: "archivebox",
      checked: filter.archived,
      onPress: () => setFilter((f) => ({ ...f, archived: !f.archived, scope: "all" })),
    },
    ...(attention.length
      ? [{ title: "Mark all as read", icon: "checkmark.circle" as const, onPress: () => dismissAttention(attention.map((i) => i.thread)) }]
      : []),
    {
      title: "Go to",
      inline: true,
      children: [
        { title: "Projects", icon: "folder", onPress: () => router.push("/projects") },
        { title: "Pull requests", icon: "arrow.triangle.pull", onPress: () => router.push("/pulls") },
        {
          title: "Activity",
          icon: "waveform.path",
          subtitle: app.approvals.length ? `${app.approvals.length} waiting for you` : undefined,
          onPress: () => router.push("/activity"),
        },
        { title: "Resume a session", icon: "clock.arrow.circlepath", onPress: () => router.push("/sessions") },
      ],
    },
  ];

  const empty = emptyText(filter, agentName);
  const clear = () => setFilter((f) => ({ ...DEFAULT_FILTER, query: f.query }));

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <HeaderActions
        buttons={[
          { icon: "gearshape", label: "Settings", onPress: () => router.push("/settings") },
          { icon: "square.and.pencil", label: "New thread", onPress: () => router.dismissTo("/") },
        ]}
        menu={{ label: "More", items: menu }}
      />
      {Platform.OS === "ios" && (
        <ListSearch value={filter.query} onChangeText={(query) => setFilter((f) => ({ ...f, query }))} placeholder="Search threads" />
      )}
      <PullRefresh offset={offset} refreshing={refreshing} onRefresh={reload} label="Refreshing threads">
        <Animated.FlatList
          onScroll={onScroll}
          scrollEventThrottle={16}
          data={items}
          keyExtractor={(item) => item.key}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingBottom: space["2xl"],
            maxWidth: CONTENT_MAX_WIDTH,
            width: "100%",
            alignSelf: "center",
            flexGrow: 1,
          }}
          refreshControl={
            Platform.OS === "ios" ? (
              <RefreshControl refreshing={refreshing} onRefresh={() => void reload()} tintColor={colors.secondary} />
            ) : undefined
          }
          ListHeaderComponent={
            <View style={{ paddingHorizontal: space.lg, gap: space.md, paddingTop: space.sm }}>
              {Platform.OS !== "ios" && (
                <ListSearch value={filter.query} onChangeText={(query) => setFilter((f) => ({ ...f, query }))} placeholder="Search threads" />
              )}
              {filter.archived ? (
                <SectionHeader
                  first
                  title={agentName ? `Archived ${agentName} threads` : "Archived threads"}
                  action={{ title: "Done", label: "Show live threads", onPress: () => setFilter((f) => ({ ...f, archived: false })) }}
                />
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                  <SpaceSwitcher />
                  <View style={{ flex: 1 }}>
                    <Segmented
                      compact
                      label="Show threads"
                      options={THREAD_SCOPES}
                      value={filter.scope}
                      onChange={(scope) => setFilter((f) => ({ ...f, scope }))}
                    />
                  </View>
                </View>
              )}
              {agentName && !filter.archived ? (
                <SectionHeader
                  first
                  title={`${agentName} only`}
                  action={{ title: "Show all", label: "Show every agent", onPress: () => setFilter((f) => ({ ...f, agent: null })) }}
                />
              ) : null}
              <ErrorBanner error={error} onRetry={() => void reload()} />
            </View>
          }
          ItemSeparatorComponent={Separator}
          initialNumToRender={14}
          maxToRenderPerBatch={10}
          windowSize={7}
          renderItem={({ item, index }) =>
            item.kind === "more" ? (
              <ShowMoreRow remaining={item.remaining} onPress={() => showMore(item.projectId)} />
            ) : item.kind === "header" ? (
              <View style={{ paddingHorizontal: space.lg }}>
                <SectionHeader
                  title={item.title}
                  first={index === 0}
                  count={item.count}
                  open={item.projectId ? item.open : undefined}
                  onToggle={
                    item.projectId && !isFiltering(filter)
                      ? () => fold(item.projectId!, !!item.open)
                      : undefined
                  }
                />
              </View>
            ) : (
              <ThreadListRow row={item.row} ctx={ctx} />
            )
          }
          ListEmptyComponent={
            <Empty
              icon={filter.query ? "magnifyingglass" : filter.archived ? "archivebox" : "text.bubble"}
              title={empty.title}
              detail={empty.detail}
              action={
                isFiltering({ ...filter, query: "" }) ? (
                  <Button role="plain" size="medium" onPress={clear}>
                    Clear filters
                  </Button>
                ) : !filter.query ? (
                  <Button size="medium" icon="square.and.pencil" onPress={() => router.dismissTo("/")}>
                    Start a thread
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </PullRefresh>
    </View>
  );
}
