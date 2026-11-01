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
import { useLists } from "../state/useLists";
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
import { DisclosureRow, ListSurface, SectionHeader } from "../ui/List";
import type { MenuItem } from "../ui/menuModel";
import { Empty, Icon, IconButton, T, Tap } from "../ui/primitives";
import { SearchField } from "../ui/Search";
import { Segmented } from "../ui/Segmented";
import { SpaceTile } from "../ui/SpaceTile";
import { radius, space, useTheme } from "../ui/theme";
import { useMachineMenuItems } from "./MachineFilter";
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

/**
 * The sidebar's title: the active space when there are two or more, else the wordmark.
 * Its menu switches computers and spaces, like Home's title and space chip.
 */
function SidebarTitle() {
  const { colors } = useTheme();
  const s = useSpaces();
  const computers = useMachineMenuItems();
  const spaces = useSpaceMenuItems();
  const items = [...computers, ...spaces];
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
    <MenuButton
      items={items}
      label={active ? `Space: ${active.name}. Filter by machine or switch space` : "Filter by machine or switch space"}
      radius={radius.md}
      style={{ flexShrink: 1 }}
    >
      <View style={{ borderRadius: radius.md }}>{content}</View>
    </MenuButton>
  );
}

type NavIcon = "checklist" | "doc.text" | "folder" | "waveform.path" | "gearshape";

/**
 * A destination row at iPadOS sidebar density: 40 pt at the default text size (it grows with Dynamic Type), the icon
 * in a 24 pt column 8 pt from the label, so the threads get the height. Same icons, type and selection pill as the
 * list rows; the icon lines up with the search field and the thread filter.
 */
function SidebarNavRow({ title, icon, meta, selected, onPress }: { title: string; icon: NavIcon; meta?: string; selected: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Tap
      label={meta ? `${title}, ${meta}` : title}
      selected={selected}
      feedback="highlight"
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 40,
        paddingVertical: 6,
        paddingHorizontal: space.sm,
        borderRadius: radius.md,
        backgroundColor: selected ? colors.accentSoft : "transparent",
      }}
    >
      <View style={{ width: 24, alignItems: "center" }}>
        <Icon name={icon} size={20} color={selected ? colors.accent : colors.secondary} />
      </View>
      <T variant="body" tone={selected ? "accent" : "ink"} numberOfLines={1} style={[{ flex: 1 }, selected ? { fontWeight: "600" } : null]}>
        {title}
      </T>
      {meta ? (
        <T variant="subhead" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
          {meta}
        </T>
      ) : null}
    </Tap>
  );
}

// The persistent threads rail beside the detail on wide layouts. The shell owns
// the collapse/resize animation; this always fills its column.
export function Sidebar() {
  const app = useApp();
  const lists = useLists();
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

  const isWorking = useCallback((t: Thread) => threadHasActivity(t, lists.activity), [lists.activity]);
  const top = useMemo(
    () => filterThreads({ threads: lists.threads, projects: lists.projects, spaceId, filter, isWorking }),
    [lists.threads, lists.projects, spaceId, filter, isWorking],
  );
  const groups = useMemo(() => groupByProject(top, lists.projects, list.projectOrder), [top, lists.projects, list.projectOrder]);
  const children = useMemo(() => Object.values(list.children), [list.children]);
  const live = useMemo(
    () => filterThreads({ threads: lists.threads, projects: lists.projects, spaceId, filter: DEFAULT_FILTER, isWorking }),
    [lists.threads, lists.projects, spaceId, isWorking],
  );
  const attention = useMemo(() => attentionItems(live, attentionSignals(list)), [live, list]);
  const agents = useMemo(() => threadAgents(live, filter.agent), [live, filter.agent]);
  const agentName = filter.agent ? (PROVIDER_DISPLAY_NAME[filter.agent] ?? filter.agent) : undefined;
  const filtering = isFiltering(filter);

  const ctx = useMemo<ThreadRowContext>(
    () => ({
      variant: "sidebar",
      activeId,
      projectName: (id) => lists.projects.find((p) => p.id === id)?.name ?? "Free chat",
      machine: lists.machineOfThread,
      activity: lists.activity,
      onToggleChildren: (id, open) => setExpanded((value) => ({ ...value, [id]: open })),
    }),
    [activeId, lists],
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

  // Settings is not a place in the list: it sits in the sidebar's footer, below the threads.
  const nav: { title: string; icon: NavIcon; path: string; meta?: string }[] = [
    { title: "Tasks", icon: "checklist", path: "/todo", meta: taskActivity || undefined },
    { title: "Notes", icon: "doc.text", path: "/notes" },
    { title: "Projects", icon: "folder", path: "/projects" },
    { title: "Activity", icon: "waveform.path", path: "/activity", meta: app.approvals.length ? String(app.approvals.length) : undefined },
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
      {/* Rows rest on the material itself. An opaque lift colour here became every row's resting fill on iOS, and the
          rounded inset of each stacked row then scalloped the list's edges; a selected row still draws its pill. */}
      <ListSurface color="transparent">
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
          contentContainerStyle={{ paddingBottom: space.lg }}
        >
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.xs, paddingBottom: space.sm }}>
            <SearchField
              value={filter.query}
              onChangeText={(query) => setFilter((f) => ({ ...f, query }))}
              placeholder="Search threads"
            />
          </View>
          <View style={{ paddingHorizontal: ROW_INSET }}>
            {nav.map((item) => (
              <SidebarNavRow
                key={item.path}
                title={item.title}
                icon={item.icon}
                meta={item.meta}
                selected={pathname === item.path}
                onPress={() => router.navigate(item.path as never)}
              />
            ))}
          </View>
          <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>
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
        <View
          style={{
            paddingHorizontal: ROW_INSET,
            paddingTop: space.xs,
            paddingBottom: Math.max(insets.bottom, space.sm),
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
          }}
        >
          <SidebarNavRow title="Settings" icon="gearshape" selected={pathname === "/settings"} onPress={() => router.navigate("/settings")} />
        </View>
      </ListSurface>
    </View>
  );
}
