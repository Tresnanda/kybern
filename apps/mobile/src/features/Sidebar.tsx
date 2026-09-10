import * as Haptics from "expo-haptics";
import { router, useGlobalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Alert } from "../ui/Alert";
import { Brand } from "../ui/Brand";
import { useLayout } from "../state/layout";
import { threadHasActivity, refresh, rpc, useApp } from "../state/runtime";
import {
  filterThreads,
  relativeTime,
  THREAD_FILTERS,
  type ThreadFilter,
} from "../state/threadList";
import { type Thread, PROVIDER_DISPLAY_NAME } from "../state/protocol";
import { Empty, Icon, IconButton, Row, styles, T, Tap } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { type, useTheme } from "../ui/theme";

const MAX_PROJECT_THREADS = 8;

function ThreadRow({
  thread,
  active,
  onOptions,
}: {
  thread: Thread;
  active: boolean;
  onOptions: (t: Thread) => void;
}) {
  const app = useApp();
  const { colors } = useTheme();
  const running = threadHasActivity(thread, app.activity);
  return (
    <Tap
      label={`${thread.title || "Untitled thread"}, ${running ? "Working" : thread.status}`}
      selected={active}
      onPress={() =>
        router.navigate({
          pathname: "/thread/[id]",
          params: { id: thread.id },
        })
      }
      onLongPress={() => onOptions(thread)}
      style={{
        paddingStart: 12,
        paddingEnd: 10,
        paddingVertical: 9,
        borderRadius: 11,
        gap: 4,
        backgroundColor: active ? colors.raised : undefined,
      }}
    >
      <View style={styles.spread}>
        <T variant="label" numberOfLines={1} style={{ flex: 1 }}>
          {thread.title || "Untitled thread"}
        </T>
        {thread.pinned ? (
          <Icon name="pin.fill" size={11} color={colors.secondary} />
        ) : running ? (
          <Icon name="circle.dotted" size={12} color={colors.accent} />
        ) : (
          <T variant="caption" tone="muted">
            {relativeTime(thread.updated_at)}
          </T>
        )}
      </View>
      <View style={[styles.line, { gap: 7 }]}>
        <ProviderMark kind={thread.provider.kind} size={12} />
        <T variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {PROVIDER_DISPLAY_NAME[thread.provider.kind]}
        </T>
      </View>
    </Tap>
  );
}

// Threads grouped under a collapsible project header, mirroring the desktop
// sidebar. The project heading is the group; its threads sit indented beneath.
function ProjectGroup({
  name,
  threads,
  activeId,
  onOptions,
}: {
  name: string;
  threads: Thread[];
  activeId?: string;
  onOptions: (t: Thread) => void;
}) {
  const { colors } = useTheme();
  const hasActive = threads.some((t) => t.id === activeId);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const open = collapsed && !hasActive ? false : true;
  const shown =
    showAll || threads.length <= MAX_PROJECT_THREADS
      ? threads
      : threads.slice(0, MAX_PROJECT_THREADS);
  const hidden = threads.length - shown.length;
  return (
    <View style={{ marginBottom: 6 }}>
      <Tap
        label={`${name}, ${threads.length} threads`}
        expanded={open}
        static
        onPress={() => setCollapsed((c) => !c)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingStart: 8,
          paddingEnd: 8,
          paddingVertical: 7,
          borderRadius: 9,
        }}
      >
        <Icon
          name={open ? "folder.fill" : "folder"}
          size={14}
          color={colors.secondary}
        />
        <T variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {name}
        </T>
        <Icon
          name={open ? "chevron.down" : "chevron.right"}
          size={10}
          color={colors.muted}
        />
      </Tap>
      {open && (
        <View>
          {shown.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === activeId}
              onOptions={onOptions}
            />
          ))}
          {hidden > 0 && (
            <Tap
              label={`Show ${hidden} more threads`}
              onPress={() => setShowAll(true)}
              style={{ paddingStart: 12, paddingVertical: 7 }}
            >
              <T variant="caption" tone="accent">
                Show {hidden} more
              </T>
            </Tap>
          )}
        </View>
      )}
    </View>
  );
}

// The persistent threads rail shown beside the detail on wide layouts. The shell
// owns the collapse/resize animation; this always fills its column.
export function Sidebar() {
  const app = useApp();
  const { colors } = useTheme();
  const { toggleSidebar } = useLayout();
  const insets = useSafeAreaInsets();
  const activeId = useGlobalSearchParams<{ id?: string }>().id;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ThreadFilter>("All");
  const rows = useMemo(
    () =>
      filterThreads({
        threads: app.threads,
        projects: app.projects,
        activity: app.activity,
        query,
        filter,
      }),
    [app.threads, app.projects, app.activity, query, filter],
  );
  // Group by project, ordering projects by their most recently updated thread.
  const groups = useMemo(() => {
    const byProject = new Map<string, Thread[]>();
    for (const t of rows) {
      const list = byProject.get(t.project_id);
      if (list) list.push(t);
      else byProject.set(t.project_id, [t]);
    }
    return [...byProject.entries()]
      .map(([projectId, threads]) => ({
        projectId,
        name: app.projects.find((p) => p.id === projectId)?.name ?? "Project",
        threads,
        recent: threads.reduce(
          (max, t) => (t.updated_at > max ? t.updated_at : max),
          "",
        ),
      }))
      .sort((a, b) => b.recent.localeCompare(a.recent));
  }, [rows, app.projects]);

  function options(t: Thread) {
    Alert.alert(t.title || "Thread", undefined, [
      {
        text: t.pinned ? "Unpin thread" : "Pin thread",
        onPress: () => {
          void rpc("threads.update", { thread_id: t.id, pinned: !t.pinned })
            .then(refresh)
            .catch(() => {});
        },
      },
      ...(t.status !== "archived"
        ? [
            {
              text: "Archive thread",
              onPress: () => {
                void rpc("threads.archive", { thread_id: t.id })
                  .then(refresh)
                  .catch(() => {});
              },
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  return (
    <View
      style={{
        flex: 1,
        width: "100%",
        backgroundColor: colors.background,
      }}
    >
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingBottom: 6,
          paddingStart: 18,
          paddingEnd: 8,
          ...styles.spread,
        }}
      >
        <View style={[styles.line, { gap: 9 }]}>
          <Brand size={20} />
          <T variant="heading" style={{ fontSize: 18 }}>
            kybern
          </T>
        </View>
        <View style={styles.line}>
          <IconButton
            name="square.and.pencil"
            label="Start a thread"
            onPress={() => router.navigate("/")}
          />
          <IconButton
            name="sidebar.left"
            label="Hide sidebar"
            onPress={toggleSidebar}
          />
        </View>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 10, paddingBottom: 16 }}
      >
        <View
          style={{
            ...styles.line,
            gap: 8,
            backgroundColor: colors.raised,
            borderRadius: 13,
            paddingHorizontal: 11,
            marginTop: 6,
            marginBottom: 12,
          }}
        >
          <Icon name="magnifyingglass" size={16} color={colors.secondary} />
          <TextInput
            underlineColorAndroid="transparent"
            accessibilityLabel="Search threads"
            placeholder="Search threads"
            value={query}
            onChangeText={setQuery}
            placeholderTextColor={colors.muted}
            style={[type.caption, { color: colors.ink, flex: 1, minHeight: 42 }]}
          />
        </View>
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            marginBottom: 14,
            flexWrap: "wrap",
          }}
        >
          {THREAD_FILTERS.map((f) => (
            <Tap
              key={f}
              label={f}
              selected={f === filter}
              onPress={() => {
                setFilter(f);
                void Haptics.selectionAsync();
              }}
              style={{
                backgroundColor: filter === f ? colors.ink : colors.raised,
                paddingHorizontal: 12,
                borderRadius: 20,
              }}
            >
              <T variant="caption" tone={filter === f ? "inverse" : "secondary"}>
                {f}
              </T>
            </Tap>
          ))}
        </View>
        {groups.map((g) => (
          <ProjectGroup
            key={g.projectId}
            name={g.name}
            threads={g.threads}
            activeId={activeId}
            onOptions={options}
          />
        ))}
        {rows.length === 0 && (
          <View style={{ paddingHorizontal: 4 }}>
            <Empty
              title={query ? "No matches" : "A fresh page."}
              detail={
                query
                  ? `Nothing matches “${query}”.`
                  : "Start a conversation and it appears here."
              }
            />
          </View>
        )}
        <View
          style={{
            marginTop: 14,
            paddingTop: 8,
            paddingHorizontal: 4,
            borderTopWidth: 0.5,
            borderColor: colors.line,
          }}
        >
          <Row
            title="Projects"
            icon="folder"
            onPress={() => router.navigate("/projects")}
          />
          <Row
            title="Activity"
            icon="waveform.path"
            detail={
              app.approvals.length
                ? `${app.approvals.length} waiting for you`
                : undefined
            }
            onPress={() => router.navigate("/activity")}
          />
          <Row
            title="Resume a session"
            icon="clock.arrow.circlepath"
            onPress={() => router.navigate("/sessions")}
          />
          <Row
            title="Settings"
            icon="gearshape"
            onPress={() => router.navigate("/settings")}
          />
        </View>
      </ScrollView>
    </View>
  );
}
