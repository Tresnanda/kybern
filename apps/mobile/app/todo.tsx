import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  Platform,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  useAnimatedScrollHandler,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScopeBar } from "../src/features/ScopeBar";
import { TaskRow, useMinuteClock } from "../src/features/TaskRow";
import { TaskToast } from "../src/features/TaskToast";
import { count } from "../src/state/format";
import { isFreeChatProject, type TaskItem, type TaskStatus } from "../src/state/protocol";
import { createTask, loadTasks, useTasks } from "../src/state/tasks";
import {
  STATUS_LABEL,
  groupTasks,
  isOpenStatus,
  scopeTasks,
  startsCollapsed,
} from "../src/state/tasksModel";
import { useProjectScope } from "../src/state/projectScope";
import { errorText, useApp } from "../src/state/runtime";
import { useInSpace, useSpaceProjects } from "../src/state/spaces";
import { HeaderActions, MenuButton, type MenuItem } from "../src/ui/ActionMenu";
import { Alert } from "../src/ui/Alert";
import { ChromeBar } from "../src/ui/ChromeBar";
import { haptics } from "../src/ui/haptics";
import { InsetGroup, SectionHeader } from "../src/ui/List";
import {
  Button,
  Empty,
  Icon,
  IconButton,
  T,
} from "../src/ui/primitives";
import { PullRefresh } from "../src/ui/PullRefresh";
import { ProjectDot, StatusGlyph } from "../src/ui/TaskGlyphs";
import {
  CONTENT_MAX_WIDTH,
  maxScale,
  radius,
  space,
  type,
  useTheme,
} from "../src/ui/theme";

type Row =
  | { key: string; kind: "header"; status: TaskStatus; count: number; collapsible: boolean; open: boolean; first: boolean }
  | { key: string; kind: "task"; task: TaskItem; separator: boolean };

type Layout = "list" | "board";

/**
 * One line to capture a task. Return adds it to Inbox and keeps the keyboard up
 * for the next. Under All, a chip in the field says (and changes) where it goes.
 */
function QuickAdd({
  where,
  destinations,
  disabled,
  onAdd,
}: {
  where: string;
  /** The destination menu, only when the list shows every scope. */
  destinations?: { items: MenuItem[]; projectId: string | null };
  disabled: boolean;
  onAdd: (title: string) => Promise<unknown>;
}) {
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = () => {
    const title = text.trim();
    if (!title || busy) return;
    setBusy(true);
    void onAdd(title)
      .then(() => {
        setText("");
        haptics.success();
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        minHeight: 48,
        marginHorizontal: space.lg,
        marginTop: space.md,
        paddingStart: space.md,
        paddingEnd: space.xs,
        borderRadius: radius.sm,
        backgroundColor: colors.raised,
      }}
    >
      <Icon name="plus.circle.fill" size={20} color={disabled ? colors.muted : colors.accent} />
      <TextInput
        underlineColorAndroid="transparent"
        accessibilityLabel={`New task in ${where}`}
        accessibilityHint="Adds the task to Inbox"
        placeholder="New task"
        value={text}
        editable={!disabled}
        onChangeText={setText}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        returnKeyType="done"
        submitBehavior="submit"
        onSubmitEditing={submit}
        maxLength={300}
        maxFontSizeMultiplier={maxScale("body")}
        style={[type.body, { letterSpacing: 0, color: colors.ink, flex: 1, minHeight: 48 }]}
      />
      {text.trim() ? (
        <IconButton name="arrow.up" label="Add task" onPress={submit} disabled={busy} color={colors.accent} />
      ) : destinations ? (
        <MenuButton
          items={destinations.items}
          title="Add new tasks to"
          label={`Adds to ${where}. Change`}
          radius={radius.full}
          disabled={disabled}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              minHeight: 36,
              paddingHorizontal: space.md,
            }}
          >
            <ProjectDot projectId={destinations.projectId} />
            <T variant="footnote" tone="secondary" numberOfLines={1} style={{ maxWidth: 140 }}>
              {where}
            </T>
            <Icon name="chevron.up.chevron.down" size={11} color={colors.muted} />
          </View>
        </MenuButton>
      ) : null}
    </View>
  );
}

/** Board: one column per status, paging sideways. Moving a task between columns is its Status menu. */
function Board({
  tasks,
  now,
  showProject,
  projectName,
  selecting,
  selected,
  onToggleSelect,
}: {
  tasks: TaskItem[];
  now: number;
  showProject: boolean;
  projectName: (id?: string | null) => string | undefined;
  selecting: boolean;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const column = Math.min(340, Math.round(width * 0.84));
  const groups = groupTasks(tasks);
  // The columns a person moves work through stay even when empty.
  for (const status of ["todo", "inbox"] as const)
    if (!groups.some((g) => g.status === status)) groups.push({ status, tasks: [] });
  groups.sort(
    (a, b) =>
      ["running", "needs_review", "todo", "inbox", "done", "canceled"].indexOf(a.status) -
      ["running", "needs_review", "todo", "inbox", "done", "canceled"].indexOf(b.status),
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={column + space.md}
      decelerationRate="fast"
      contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }}
      style={{ flex: 1 }}
    >
      {groups.map((group) => (
        <ScrollView
          key={group.status}
          style={{ width: column }}
          contentContainerStyle={{ paddingBottom: insets.bottom + space["3xl"] }}
          showsVerticalScrollIndicator={false}
        >
          <SectionHeader
            title={STATUS_LABEL[group.status]}
            leading={<StatusGlyph status={group.status} size={16} />}
            count={group.tasks.length}
            inset
          />
          {group.tasks.length ? (
            <InsetGroup>
              {group.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  now={now}
                  showProject={showProject}
                  projectName={projectName(task.project_id)}
                  selecting={selecting}
                  selected={selected.has(task.id)}
                  onToggleSelect={onToggleSelect}
                  swipeable={false}
                />
              ))}
            </InsetGroup>
          ) : (
            <Empty variant="inline" title="Nothing here" />
          )}
        </ScrollView>
      ))}
    </ScrollView>
  );
}

export default function Tasks() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const { tasks: allTasks, loaded, unsupported, error, toast } = useTasks();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  const connected = app.status === "open";
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const [view, setView] = useState<Layout>("list");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Where quick add puts a task while every scope is listed (null: Global).
  const [chosenDestination, setDestination] = useState<string | null>(null);
  // A link from a project page opens on that project; the filter can widen it.
  const [scope, setScope] = useProjectScope("tasks", projectId);
  const projectName = useCallback(
    (id?: string | null) => (id ? app.projects.find((p) => p.id === id)?.name : undefined),
    [app.projects],
  );
  // Global tasks show in every space; project tasks in their project's space.
  const inSpace = useInSpace();
  const spaceProjects = useSpaceProjects();
  const tasks = useMemo(() => allTasks.filter((t) => inSpace(t.project_id)), [allTasks, inSpace]);
  const offset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      offset.set(event.contentOffset.y);
    },
  });

  const visible = useMemo(
    () => (scope === "all" ? tasks : scopeTasks(allTasks, scope)),
    [tasks, allTasks, scope],
  );
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const group of groupTasks(visible)) {
      const collapsible = startsCollapsed(group.status);
      const expanded = !collapsible || !!open[group.status];
      out.push({
        key: `h:${group.status}`,
        kind: "header",
        status: group.status,
        count: group.tasks.length,
        collapsible,
        open: expanded,
        first: out.length === 0,
      });
      if (expanded)
        group.tasks.forEach((task, i) =>
          out.push({ key: task.id, kind: "task", task, separator: i < group.tasks.length - 1 }),
        );
    }
    return out;
  }, [visible, open]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    await loadTasks();
    setRefreshing(false);
  }, []);

  // A destination from another space falls back to Global.
  const destination = spaceProjects.some((p) => p.id === chosenDestination) ? chosenDestination : null;
  const targetProject =
    scope === "all" ? destination : scope === "global" ? null : scope;
  const where = targetProject ? (projectName(targetProject) ?? "this project") : "Global";
  const add = useCallback(
    (title: string) =>
      createTask({ title, projectId: targetProject }).catch((e) => {
        Alert.alert("Unable to add the task", errorText(e), [{ text: "OK" }]);
        throw e;
      }),
    [targetProject],
  );
  const destinations =
    scope === "all"
      ? {
          projectId: destination,
          items: [
            { title: "Global", checked: destination === null, onPress: () => setDestination(null) },
            ...spaceProjects
              .filter((p) => !isFreeChatProject(p.id))
              .map((p) => ({
                title: p.name,
                checked: destination === p.id,
                onPress: () => setDestination(p.id),
              })),
          ],
        }
      : undefined;
  const showProject = scope === "all";
  const nothing = loaded && !unsupported && !visible.length;

  const toggleSelect = useCallback((id: string) => {
    haptics.select();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  // Tasks a run can start from: anything open that no run is working on.
  const sendable = [...selected].filter((id) => {
    const task = allTasks.find((t) => t.id === id);
    return task && isOpenStatus(task.status) && task.status !== "running";
  });

  const header = (
    <View>
      {loaded && !unsupported && <ScopeBar scope={scope} onChange={setScope} />}
      {(loaded || connected) && !unsupported && !selecting && (
        <QuickAdd where={where} destinations={destinations} disabled={!connected} onAdd={add} />
      )}
    </View>
  );

  const empty =
    !connected && !loaded ? (
      <Empty
        icon="checklist"
        title="Connect your computer"
        detail="Tasks live on your computer and sync with this phone."
        action={
          <Button onPress={() => router.push(app.activeId ? "/settings" : "/connect")}>
            {app.activeId ? "Open connections" : "Connect your computer"}
          </Button>
        }
      />
    ) : unsupported ? (
      <Empty
        icon="checklist"
        title="Update Kybern on your computer"
        detail="This computer’s Kybern is too old for tasks. Update it, then open Tasks again."
      />
    ) : !loaded ? (
      <Empty variant="inline" title="Loading tasks…" />
    ) : nothing ? (
      <Empty
        icon="checklist"
        title={scope === "all" ? "Nothing to do yet" : `No tasks in ${where}`}
        detail="Write down what needs doing, then send it to an agent. It runs on your computer and comes back for review."
      />
    ) : null;

  return (
    <View style={{ flex: 1, backgroundColor: view === "board" ? colors.grouped : colors.background }}>
      <Stack.Screen
        options={{
          title: selecting
            ? selected.size
              ? `${selected.size} selected`
              : "Select tasks"
            : "Tasks",
          // The board pages sideways under a plain bar; the list keeps the large title.
          headerLargeTitleEnabled: !selecting && view === "list",
          headerStyle: { backgroundColor: view === "board" ? colors.grouped : colors.background },
        }}
      />
      {selecting ? (
        <HeaderActions buttons={[{ title: "Done", prominent: true, onPress: stopSelecting }]} />
      ) : (
        <HeaderActions
          menu={{
            label: "Task list options",
            items: [
              {
                title: "View",
                inline: true,
                children: [
                  { title: "List", icon: "list.bullet", checked: view === "list", onPress: () => setView("list") },
                  { title: "Board", icon: "rectangle.split.3x1", checked: view === "board", onPress: () => setView("board") },
                ],
              },
              {
                title: "Select tasks",
                icon: "checkmark.circle",
                disabled: !connected || !visible.length,
                onPress: () => setSelecting(true),
              },
            ],
          }}
        />
      )}
      {view === "board" && visible.length ? (
        <View style={{ flex: 1 }}>
          {header}
          <Board
            tasks={visible}
            now={now}
            showProject={showProject}
            projectName={projectName}
            selecting={selecting}
            selected={selected}
            onToggleSelect={toggleSelect}
          />
        </View>
      ) : (
        <PullRefresh offset={offset} refreshing={refreshing} onRefresh={reload} label="Refreshing tasks">
          <Animated.FlatList
            data={rows}
            onScroll={onScroll}
            scrollEventThrottle={16}
            keyExtractor={(row) => row.key}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{
              paddingBottom: insets.bottom + space["3xl"] + (selecting ? 72 : 0) + (toast ? 72 : 0),
              maxWidth: CONTENT_MAX_WIDTH,
              width: "100%",
              alignSelf: "center",
            }}
            refreshControl={
              Platform.OS === "ios" ? (
                <RefreshControl refreshing={refreshing} onRefresh={() => void reload()} />
              ) : undefined
            }
            ListHeaderComponent={header}
            renderItem={({ item }) =>
              item.kind === "header" ? (
                <SectionHeader
                  title={STATUS_LABEL[item.status]}
                  leading={<StatusGlyph status={item.status} size={16} />}
                  count={item.count}
                  open={item.collapsible ? item.open : undefined}
                  onToggle={
                    item.collapsible
                      ? () => setOpen((v) => ({ ...v, [item.status]: !item.open }))
                      : undefined
                  }
                  inset
                />
              ) : (
                <TaskRow
                  task={item.task}
                  now={now}
                  showProject={showProject}
                  projectName={projectName(item.task.project_id)}
                  separator={item.separator}
                  selecting={selecting}
                  selected={selected.has(item.task.id)}
                  onToggleSelect={toggleSelect}
                />
              )
            }
            ListEmptyComponent={empty}
            ListFooterComponent={
              error ? (
                <T variant="footnote" tone="negative" style={{ paddingVertical: space.md, paddingHorizontal: space.lg }}>
                  {error}
                </T>
              ) : null
            }
          />
        </PullRefresh>
      )}
      {selecting && (
        <ChromeBar edge="bottom">
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              width: "100%",
              maxWidth: CONTENT_MAX_WIDTH,
              alignSelf: "center",
            }}
          >
            <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
              {selected.size && sendable.length < selected.size
                ? `${count(selected.size - sendable.length, "task")} already running or finished`
                : selected.size
                  ? count(selected.size, "task")
                  : "Tap tasks to send them together"}
            </T>
            <Button
              icon="paperplane"
              disabled={!sendable.length || !connected}
              onPress={() => {
                router.push({ pathname: "/todo-send", params: { ids: sendable.join(",") } });
                stopSelecting();
              }}
            >
              Send to agent
            </Button>
          </View>
        </ChromeBar>
      )}
      <TaskToast />
    </View>
  );
}
