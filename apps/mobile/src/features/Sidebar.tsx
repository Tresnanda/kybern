import { attentionItems } from "../../../../packages/kybern-client/src/threadAttention";
import { BlurView } from "expo-blur";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLayout } from "../state/layout";
import { attentionSignals, dismissAttention, useListState } from "../state/listState";
import { PROVIDER_DISPLAY_NAME, type Thread } from "../state/protocol";
import { threadHasActivity, useApp } from "../state/runtime";
import { currentSpaceId, useSpaces } from "../state/spaces";
import { useTasks } from "../state/tasks";
import { activitySummary } from "../state/tasksModel";
import {
  DEFAULT_FILTER,
  emptyText,
  filterThreads,
  groupByProject,
  isFiltering,
  threadAgents,
  threadRows,
  THREAD_SCOPES,
  type ThreadFilter,
} from "../state/threadList";
import { MenuButton } from "../ui/ActionMenu";
import { Brand } from "../ui/Brand";
import { useReduceTransparency, useWindowControlsInset } from "../ui/ChromeBar";
import { DisclosureRow, ListRow, ListSurface, SectionHeader } from "../ui/List";
import type { MenuItem } from "../ui/menuModel";
import { Empty, Icon, IconButton, T } from "../ui/primitives";
import { SearchField } from "../ui/Search";
import { Segmented } from "../ui/Segmented";
import { SpaceTile } from "../ui/SpaceTile";
import { radius, space, useTheme } from "../ui/theme";
import { useSpaceMenuItems } from "./Spaces";
import { ThreadListRow, type ThreadRowContext } from "./ThreadRows";

const MAX_PROJECT_THREADS = 8;
/** Rows sit 8 pt in from the sidebar edges so a selection reads as a rounded pill. */
const ROW_INSET = space.sm;

/** iPadOS sidebar material: system chrome blur on iOS (opaque with Reduce Transparency), an opaque tint elsewhere. */
function SidebarMaterial() {
  const { colors, dark } = useTheme();
  const reduced = useReduceTransparency();
  if (Platform.OS === "ios" && !reduced)
    return <BlurView tint="systemChromeMaterial" intensity={100} style={StyleSheet.absoluteFill} />;
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: dark ? colors.surface : colors.grouped }]} />;
}

/** The sidebar's title: the active space (a switcher) when there are two or more, else the wordmark. */
function SidebarTitle() {
  const { colors } = useTheme();
  const s = useSpaces();
  const items = useSpaceMenuItems();
  const active = s.spaces.find((x) => x.id === currentSpaceId(s));
  const content = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44, paddingHorizontal: space.sm }}>
      {active && s.spaces.length > 1 ? <SpaceTile space={active} size={24} /> : <Brand size={22} />}
      <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
        {active && s.spaces.length > 1 ? active.name : "kybern"}
      </T>
      {items.length ? <Icon name="chevron.up.chevron.down" size={12} color={colors.muted} /> : null}
    </View>
  );
  if (!items.length) return content;
  return (
    <MenuButton items={items} title="Space" label={active ? `Space: ${active.name}. Switch space` : "Spaces"} radius={radius.md} style={{ flexShrink: 1 }}>
      <View style={{ borderRadius: radius.md }}>{content}</View>
    </MenuButton>
  );
}

// The persistent threads rail beside the detail on wide layouts. The shell owns
// the collapse/resize animation; this always fills its column.
export function Sidebar() {
  const app = useApp();
  const list = useListState();
  const spaces = useSpaces();
  const spaceId = currentSpaceId(spaces);
  const taskActivity = activitySummary(useTasks().tasks);
  const { colors } = useTheme();
  const { toggleSidebar } = useLayout();
  const insets = useSafeAreaInsets();
  const controls = useWindowControlsInset();
  const pathname = usePathname();
  const activeId = useGlobalSearchParams<{ id?: string }>().id;
  const [filter, setFilter] = useState<ThreadFilter>(DEFAULT_FILTER);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const isWorking = useCallback((t: Thread) => threadHasActivity(t, app.activity), [app.activity]);
  const top = useMemo(
    () => filterThreads({ threads: app.threads, projects: app.projects, spaceId, filter, isWorking }),
    [app.threads, app.projects, spaceId, filter, isWorking],
  );
  const groups = useMemo(() => groupByProject(top, app.projects, list.projectOrder), [top, app.projects, list.projectOrder]);
  const children = useMemo(() => Object.values(list.children), [list.children]);
  const live = useMemo(
    () => filterThreads({ threads: app.threads, projects: app.projects, spaceId, filter: DEFAULT_FILTER, isWorking }),
    [app.threads, app.projects, spaceId, isWorking],
  );
  const attention = useMemo(() => attentionItems(live, attentionSignals(list)), [live, list]);
  const agents = useMemo(() => threadAgents(live, filter.agent), [live, filter.agent]);
  const agentName = filter.agent ? (PROVIDER_DISPLAY_NAME[filter.agent] ?? filter.agent) : undefined;
  const filtering = isFiltering(filter);

  const ctx = useMemo<ThreadRowContext>(
    () => ({
      variant: "sidebar",
      activeId,
      projectName: (id) => app.projects.find((p) => p.id === id)?.name ?? "Free chat",
      onToggleChildren: (id, open) => setExpanded((value) => ({ ...value, [id]: open })),
    }),
    [activeId, app.projects],
  );

  const menu: MenuItem[] = [
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
    { title: "Resume a session", icon: "clock.arrow.circlepath", onPress: () => router.navigate("/sessions") },
  ];

  const nav: { title: string; icon: "checklist" | "doc.text" | "folder" | "waveform.path" | "gearshape"; path: string; meta?: string }[] = [
    { title: "Tasks", icon: "checklist", path: "/todo", meta: taskActivity || undefined },
    { title: "Notes", icon: "doc.text", path: "/notes" },
    { title: "Projects", icon: "folder", path: "/projects" },
    { title: "Activity", icon: "waveform.path", path: "/activity", meta: app.approvals.length ? String(app.approvals.length) : undefined },
    { title: "Settings", icon: "gearshape", path: "/settings" },
  ];
  const empty = emptyText(filter, agentName);
  const inset = (node: ReactNode, key: string) => (
    <View key={key} style={{ marginHorizontal: ROW_INSET, borderRadius: radius.md, overflow: "hidden" }}>
      {node}
    </View>
  );

  return (
    <View style={{ flex: 1, width: "100%" }}>
      <SidebarMaterial />
      <ListSurface color="transparent" lift={colors.surface}>
        <View
          style={{
            paddingTop: insets.top + space.xs,
            paddingStart: Math.max(space.sm, controls),
            paddingEnd: space.xs,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.xs,
          }}
        >
          <SidebarTitle />
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <IconButton name="square.and.pencil" label="New thread" onPress={() => router.navigate("/")} />
            <IconButton name="sidebar.left" label="Hide sidebar" onPress={toggleSidebar} />
          </View>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + space.lg }}
        >
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.sm }}>
            <SearchField
              value={filter.query}
              onChangeText={(query) => setFilter((f) => ({ ...f, query }))}
              placeholder="Search threads"
            />
          </View>
          {nav.map((item) =>
            inset(
              <ListRow
                title={item.title}
                leading={item.icon}
                meta={item.meta}
                selected={pathname === item.path}
                onPress={() => router.navigate(item.path as never)}
              />,
              item.path,
            ),
          )}
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.xl, gap: space.sm }}>
            {filter.archived ? (
              <SectionHeader
                first
                title="Archived threads"
                action={{ title: "Done", label: "Show live threads", onPress: () => setFilter((f) => ({ ...f, archived: false })) }}
              />
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <View style={{ flex: 1 }}>
                  <Segmented
                    compact
                    label="Show threads"
                    options={THREAD_SCOPES}
                    value={filter.scope}
                    onChange={(scope) => setFilter((f) => ({ ...f, scope }))}
                  />
                </View>
                <MenuButton items={menu} title="Threads" label="Thread filters" icon="ellipsis" />
              </View>
            )}
            {agentName && !filter.archived ? (
              <SectionHeader
                first
                title={`${agentName} only`}
                action={{ title: "Show all", label: "Show every agent", onPress: () => setFilter((f) => ({ ...f, agent: null })) }}
              />
            ) : null}
          </View>
          {groups.map((group) => {
            const open = filtering || !collapsed[group.projectId] || group.threads.some((t) => t.id === activeId);
            const rows = threadRows(group.threads, filter.archived ? [] : children, expanded, { now: Date.now(), activeId });
            let counted = 0;
            const shown = showAll[group.projectId] || filtering
              ? rows
              : rows.filter((row) => (row.depth === 0 ? ++counted <= MAX_PROJECT_THREADS : counted <= MAX_PROJECT_THREADS));
            const hidden = group.threads.length - shown.filter((r) => r.depth === 0).length;
            return (
              <View key={group.projectId}>
                <View style={{ paddingHorizontal: space.lg }}>
                  <SectionHeader
                    title={group.name}
                    count={group.threads.length}
                    open={open}
                    onToggle={filtering ? undefined : () => setCollapsed((c) => ({ ...c, [group.projectId]: open }))}
                  />
                </View>
                {open &&
                  shown.map((row) => inset(<ThreadListRow row={row} ctx={ctx} />, row.thread.id))}
                {open && hidden > 0 ? (
                  <View style={{ minHeight: 36, justifyContent: "center" }}>
                    <DisclosureRow
                      title={`Show ${hidden} more`}
                      open={false}
                      indent={ROW_INSET}
                      onToggle={() => setShowAll((value) => ({ ...value, [group.projectId]: true }))}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}
          {groups.length === 0 ? (
            <Empty variant="inline" title={`${empty.title}.`} />
          ) : null}
        </ScrollView>
      </ListSurface>
    </View>
  );
}
