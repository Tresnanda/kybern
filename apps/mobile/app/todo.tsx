import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TaskRow, useMinuteClock } from "../src/features/TaskRow";
import { TaskToast } from "../src/features/TaskToast";
import type { TaskItem, TaskStatus } from "../src/state/protocol";
import { createTask, loadTasks, useTasks } from "../src/state/tasks";
import {
  STATUS_LABEL,
  groupTasks,
  scopeTasks,
  startsCollapsed,
} from "../src/state/tasksModel";
import { errorText, useApp } from "../src/state/runtime";
import { Alert } from "../src/ui/Alert";
import {
  Button,
  Empty,
  Icon,
  IconButton,
  styles,
  T,
  Tap,
} from "../src/ui/primitives";
import { ProjectDot, StatusGlyph } from "../src/ui/TaskGlyphs";
import { type, useTheme } from "../src/ui/theme";

type Row =
  | { key: string; kind: "header"; status: TaskStatus; count: number; collapsible: boolean; open: boolean }
  | { key: string; kind: "task"; task: TaskItem };

/** All tasks, Global, or one project. */
type Scope = "all" | "global" | string;

function GroupHeader({
  row,
  onToggle,
}: {
  row: Extract<Row, { kind: "header" }>;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const body = (
    <View style={[styles.line, { gap: 12 }]}>
      <StatusGlyph status={row.status} size={16} />
      <T variant="label" accessibilityRole="header">
        {STATUS_LABEL[row.status]}
      </T>
      <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"], marginStart: -4 }}>
        {row.count}
      </T>
      {row.collapsible && !row.open && (
        <Icon name="chevron.right" size={11} color={colors.muted} />
      )}
    </View>
  );
  return row.collapsible ? (
    <Tap
      label={`${STATUS_LABEL[row.status]}, ${row.count}, ${row.open ? "expanded" : "collapsed"}`}
      expanded={row.open}
      static
      onPress={onToggle}
      style={{ marginTop: 20 }}
    >
      {body}
    </Tap>
  ) : (
    <View style={{ marginTop: 20, minHeight: 44, justifyContent: "center" }}>
      {body}
    </View>
  );
}

/** One line to capture a task. Return adds it to Inbox and keeps the keyboard up for the next. */
function QuickAdd({
  where,
  disabled,
  onAdd,
}: {
  where: string;
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
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ marginTop: 12, marginBottom: 4, gap: 6 }}>
      <View
        style={{
          ...styles.line,
          backgroundColor: colors.raised,
          borderRadius: 15,
          paddingStart: 13,
          paddingEnd: 4,
        }}
      >
        <Icon name="plus" size={18} color={colors.secondary} />
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
          style={[type.body, { color: colors.ink, flex: 1, minHeight: 48 }]}
        />
        {text.trim() ? (
          <IconButton name="arrow.up" label="Add task" onPress={submit} disabled={busy} />
        ) : null}
      </View>
      <T variant="caption" tone="muted" style={{ paddingStart: 4 }}>
        Adds to Inbox in {where}
      </T>
    </View>
  );
}

export default function Tasks() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const { tasks, loaded, unsupported, error } = useTasks();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  const connected = app.status === "open";
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Partial<Record<TaskStatus, boolean>>>({});
  const [chosen, setChosen] = useState<Scope>("all");
  const scope: Scope = projectId || chosen;
  const scoped = projectId ? app.projects.find((p) => p.id === projectId) : undefined;
  const projectName = useCallback(
    (id?: string | null) => (id ? app.projects.find((p) => p.id === id)?.name : undefined),
    [app.projects],
  );

  // Only scopes that hold tasks are worth a tab; the chosen one stays while it empties.
  const scopes = useMemo(() => {
    if (projectId) return [];
    const ids = new Set<string>();
    let global = false;
    for (const task of tasks)
      if (task.scope === "global" || !task.project_id) global = true;
      else ids.add(task.project_id);
    const list: { id: Scope; label: string }[] = [{ id: "all", label: "All" }];
    if (global || chosen === "global") list.push({ id: "global", label: "Global" });
    for (const project of app.projects)
      if (ids.has(project.id) || chosen === project.id)
        list.push({ id: project.id, label: project.name });
    return list.length > 2 ? list : [];
  }, [tasks, app.projects, projectId, chosen]);

  const visible = useMemo(
    () => (scope === "all" ? tasks : scopeTasks(tasks, scope)),
    [tasks, scope],
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
      });
      if (expanded)
        for (const task of group.tasks)
          out.push({ key: task.id, kind: "task", task });
    }
    return out;
  }, [visible, open]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    await loadTasks();
    setRefreshing(false);
  }, []);

  const targetProject = scope === "all" || scope === "global" ? null : scope;
  const where = targetProject ? (projectName(targetProject) ?? "this project") : "Global";
  const add = useCallback(
    (title: string) =>
      createTask({ title, projectId: targetProject }).catch((e) => {
        Alert.alert("Unable to add the task", errorText(e), [{ text: "OK" }]);
        throw e;
      }),
    [targetProject],
  );
  const showProject = !projectId && scope === "all";
  const nothing = loaded && !unsupported && !visible.length;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: scoped ? `${scoped.name} tasks` : "Tasks",
          headerLargeTitleEnabled: !scoped,
          headerRight:
            Platform.OS === "android"
              ? () => (
                  <IconButton
                    name="arrow.clockwise"
                    label="Refresh tasks"
                    disabled={refreshing || !connected}
                    onPress={() => void reload()}
                  />
                )
              : undefined,
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: insets.bottom + 96,
          maxWidth: 760,
          width: "100%",
          alignSelf: "center",
        }}
        refreshControl={
          Platform.OS === "ios" ? (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void reload()}
              tintColor={colors.ink}
            />
          ) : undefined
        }
        ListHeaderComponent={
          <View>
            {scopes.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ marginHorizontal: -20, marginTop: 4 }}
                contentContainerStyle={{ paddingHorizontal: 16, gap: 2 }}
              >
                {scopes.map((item) => {
                  const selected = item.id === scope;
                  return (
                    <Tap
                      key={item.id}
                      label={item.label}
                      selected={selected}
                      static
                      onPress={() => {
                        void Haptics.selectionAsync();
                        setChosen(item.id);
                      }}
                      style={[
                        styles.line,
                        {
                          gap: 7,
                          paddingHorizontal: 12,
                          borderRadius: 22,
                          backgroundColor: selected ? colors.raised : undefined,
                        },
                      ]}
                    >
                      {item.id !== "all" && (
                        <ProjectDot projectId={item.id === "global" ? null : item.id} />
                      )}
                      <T variant="label" tone={selected ? "ink" : "secondary"}>
                        {item.label}
                      </T>
                    </Tap>
                  );
                })}
              </ScrollView>
            )}
            {(loaded || connected) && !unsupported && (
              <QuickAdd where={where} disabled={!connected} onAdd={add} />
            )}
          </View>
        }
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <GroupHeader
              row={item}
              onToggle={() =>
                setOpen((v) => ({ ...v, [item.status]: !item.open }))
              }
            />
          ) : (
            <TaskRow
              task={item.task}
              now={now}
              showProject={showProject}
              projectName={projectName(item.task.project_id)}
            />
          )
        }
        ListEmptyComponent={
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
            <T variant="caption" tone="secondary" style={{ paddingVertical: 24 }}>
              Loading tasks…
            </T>
          ) : nothing ? (
            <Empty
              icon="checklist"
              title={scope === "all" ? "Nothing to do yet" : `No tasks in ${where}`}
              detail="Write down what needs doing, then send a task to an agent. It runs on your computer and comes back for review."
            />
          ) : null
        }
        ListFooterComponent={
          error ? (
            <T variant="caption" tone="negative" style={{ paddingVertical: 12 }}>
              {error}
            </T>
          ) : null
        }
      />
      <TaskToast />
    </View>
  );
}
