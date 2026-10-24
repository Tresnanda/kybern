import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HeaderActions } from "../src/ui/ActionMenu";
import {
  attempt,
  openSend,
  openThread,
  priorityMenuItems,
  statusMenuItems,
  taskMenuItems,
} from "../src/features/taskActions";
import { useMinuteClock } from "../src/features/TaskRow";
import { TaskToast } from "../src/features/TaskToast";
import { useNotes } from "../src/state/notes";
import { checklistBadge, noteTitle } from "../src/state/notesModel";
import type { TaskItem, TaskRun } from "../src/state/protocol";
import { activeEnvironment, errorText, useApp } from "../src/state/runtime";
import {
  clearPendingFollowup,
  fetchTask,
  followupTask,
  saveTaskText,
  showToast,
  toggleTaskCriterion,
  useTask,
  useTasks,
} from "../src/state/tasks";
import {
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASKS_CONFLICT,
  agoPhrase,
  ageLabel,
  diffLabel,
  isLiveRun,
  isUserStatus,
  latestRun,
  plainInline,
  runOutcome,
  splitTaskBody,
  taskTitle,
} from "../src/state/tasksModel";
import { Alert } from "../src/ui/Alert";
import { Check } from "../src/ui/CheckRow";
import { ChromeBar, ChromeProvider, useChromeInsets } from "../src/ui/ChromeBar";
import { haptics } from "../src/ui/haptics";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import { Markdown } from "../src/ui/Markdown";
import { ProviderMark } from "../src/ui/ProviderMark";
import { Button, Empty, IconButton, T } from "../src/ui/primitives";
import { PriorityGlyph, ProjectDot, StatusGlyph } from "../src/ui/TaskGlyphs";
import {
  CONTENT_MAX_WIDTH,
  gutter,
  maxScale,
  radius,
  space,
  type,
  useTheme,
} from "../src/ui/theme";

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "OMP",
};

function useAgentName() {
  const app = useApp();
  return (run: TaskRun) =>
    app.providers.find((p) => p.kind === run.provider.kind)?.display_name ??
    AGENT_NAMES[run.provider.kind] ??
    run.provider.kind;
}

/** Messages the latest run when it can take one, queues behind a busy one, or saves for the next run. */
function Followup({ task, run }: { task: TaskItem; run: TaskRun }) {
  const app = useApp();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const thread = app.threads.find((t) => t.id === run.thread_id);
  const busyThread =
    thread?.status === "running" || thread?.status === "awaiting-approval" || isLiveRun(run);
  const placeholder = busyThread ? `Queue a message for Run ${run.number}…` : `Message Run ${run.number}…`;
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    void followupTask(task.id, value)
      .then((result) => {
        setText("");
        haptics.success();
        if (result.sent_to)
          showToast(`Sent to Run ${latestRun(result.task)?.number ?? ""}`.trim(), {
            kind: "open",
            threadId: result.sent_to,
          });
        else showToast("Saved for the next run");
      })
      .catch((e) => Alert.alert("Unable to send the message", errorText(e), [{ text: "OK" }]))
      .finally(() => setBusy(false));
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        gap: space.xs,
        paddingStart: space.lg,
        paddingEnd: space.xs,
        borderRadius: radius.lg,
        backgroundColor: colors.raised,
      }}
    >
      <TextInput
        underlineColorAndroid="transparent"
        accessibilityLabel={placeholder.replace(/…$/, "")}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        selectionColor={colors.accent}
        value={text}
        onChangeText={setText}
        multiline
        maxLength={8000}
        maxFontSizeMultiplier={maxScale("body")}
        style={[
          type.body,
          { letterSpacing: 0, color: colors.ink, flex: 1, minHeight: 44, maxHeight: 140, paddingTop: 10, paddingBottom: 10 },
        ]}
      />
      <IconButton
        name="arrow.up"
        label={busyThread ? `Queue for Run ${run.number}` : `Send to Run ${run.number}`}
        filled={!!text.trim()}
        disabled={!text.trim() || busy}
        onPress={send}
      />
    </View>
  );
}

/**
 * The page's actions, out of the reading flow (ux-app 3.4): Send to agent before
 * any run; the live run's activity with Open; Open run + Send again for review.
 * Once a run exists, the message field for it sits underneath.
 */
function ActionBar({ task, connected }: { task: TaskItem; connected: boolean }) {
  const insets = useSafeAreaInsets();
  const run = latestRun(task);
  const live = isLiveRun(run);
  const row = { flexDirection: "row" as const, alignItems: "center" as const, gap: space.md };
  let actions;
  if (run && live)
    actions = (
      <View style={[row, { minHeight: 48, paddingStart: space.xs }]}>
        <StatusGlyph status="running" size={16} animated />
        <T variant="subhead" tone="secondary" numberOfLines={2} style={{ flex: 1 }}>
          {run.state === "waiting" ? "Waiting for your answer" : (run.activity ?? "Working")}
        </T>
        <Button role="plain" size="medium" onPress={() => openThread(run.thread_id)}>
          Open
        </Button>
      </View>
    );
  else if (run && task.status === "needs_review")
    actions = (
      <View style={row}>
        <View style={{ flex: 1 }}>
          <Button role="prominent" icon="text.bubble" onPress={() => openThread(run.thread_id)}>
            {`Open run ${run.number}`}
          </Button>
        </View>
        <Button role="plain" disabled={!connected} onPress={() => openSend(task.id)}>
          Send again
        </Button>
      </View>
    );
  else
    actions = (
      <Button icon="paperplane" disabled={!connected} onPress={() => openSend(task.id)}>
        {run ? "Send to agent again" : "Send to agent"}
      </Button>
    );
  // Absolute children ignore the avoiding view's padding: the bar follows the
  // keyboard itself, dropping the home-indicator inset while it is up.
  return (
    <KeyboardStickyView
      offset={{ closed: 0, opened: insets.bottom }}
      style={{ position: "absolute", start: 0, end: 0, bottom: 0 }}
    >
      <ChromeBar edge="bottom" style={{ position: "relative" }}>
        <View
          style={{
            gap: space.sm,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: space.sm,
            width: "100%",
            maxWidth: CONTENT_MAX_WIDTH,
            alignSelf: "center",
          }}
        >
          {actions}
          {run && connected ? <Followup task={task} run={run} /> : null}
        </View>
      </ChromeBar>
    </KeyboardStickyView>
  );
}

function TaskPage() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const { loaded } = useTasks();
  const task = useTask(id);
  const { notes } = useNotes();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const chrome = useChromeInsets();
  const insets = useSafeAreaInsets();
  const agentName = useAgentName();
  const now = useMinuteClock();
  const connected = app.status === "open";
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", body: "", revision: 0 });
  const [saving, setSaving] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const taskRef = useRef(task);
  taskRef.current = task;

  // Opened from a link before the list arrived, or a task this list does not hold yet.
  useEffect(() => {
    if (task || !connected || !loaded) return;
    let alive = true;
    void fetchTask(id)
      .then((found) => {
        if (alive && !found) setMissing(true);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
    };
  }, [task, id, connected, loaded]);

  // Leaving while editing keeps the text: save what changed, quietly.
  useEffect(
    () => () => {
      const current = taskRef.current;
      const d = draftRef.current;
      if (
        editingRef.current &&
        current &&
        (d.title !== current.title || d.body !== current.body)
      )
        void saveTaskText(current.id, { title: d.title, body: d.body }, d.revision).catch(
          () => {},
        );
    },
    [],
  );

  const parts = useMemo(() => splitTaskBody(task?.body ?? ""), [task?.body]);
  const project = task?.project_id
    ? app.projects.find((p) => p.id === task.project_id)
    : undefined;
  const page = {
    paddingHorizontal: gutter(width),
    width: "100%" as const,
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center" as const,
  };

  if (!task)
    return (
      <View style={{ flex: 1, backgroundColor: colors.grouped, ...page }}>
        <Stack.Screen options={{ title: "" }} />
        {missing ? (
          <Empty
            icon="checklist"
            title="This task is gone"
            detail="It was deleted, or it belongs to another computer."
            action={<Button onPress={() => router.back()}>Go back</Button>}
          />
        ) : (
          <Empty
            variant="inline"
            title={connected ? "Loading task…" : "Connect your computer to open this task."}
          />
        )}
      </View>
    );

  const run = latestRun(task);
  const live = isLiveRun(run);
  const done = parts.criteria.filter((c) => c.checked).length;
  const linked = task.note_ids.map((noteId) => ({
    id: noteId,
    note: notes.find((n) => n.id === noteId),
  }));
  const runs = [...task.runs].sort((a, b) => b.number - a.number);

  async function save(next: typeof draft, retry = false): Promise<boolean> {
    const current = taskRef.current;
    if (!current) return true;
    if (next.title === current.title && next.body === current.body) return true;
    setSaving(true);
    try {
      await saveTaskText(current.id, { title: next.title, body: next.body }, next.revision);
      return true;
    } catch (e) {
      if ((e as { code?: number } | null)?.code === TASKS_CONFLICT && !retry) {
        return await new Promise<boolean>((resolve) =>
          Alert.alert(
            "Edited on another device",
            "Keep mine replaces the other version. Load theirs discards your changes.",
            [
              {
                text: "Keep mine",
                onPress: () => {
                  void fetchTask(current.id)
                    .then((fresh) =>
                      save({ ...next, revision: fresh?.revision ?? next.revision }, true),
                    )
                    .then(resolve, () => resolve(false));
                },
              },
              {
                text: "Load theirs",
                style: "destructive",
                onPress: () => {
                  void fetchTask(current.id).finally(() => resolve(true));
                },
              },
            ],
          ),
        );
      }
      Alert.alert("Unable to save the task", errorText(e), [{ text: "OK" }]);
      return false;
    } finally {
      setSaving(false);
    }
  }

  function setMode(next: boolean) {
    if (next) {
      setDraft({ title: task!.title, body: task!.body, revision: task!.revision });
      setEditing(true);
      return;
    }
    void save(draftRef.current).then((ok) => {
      if (ok) setEditing(false);
    });
  }

  const where = task.project_id
    ? (project?.name ?? "Project")
    : `Global · on ${activeEnvironment()?.name ?? "your computer"}`;
  const bar = !editing;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen
        options={{ title: task.key, headerStyle: { backgroundColor: colors.grouped } }}
      />
      <HeaderActions
        buttons={[
          {
            title: editing ? "Done" : "Edit",
            prominent: editing,
            disabled: !connected || saving,
            onPress: () => setMode(!editing),
          },
        ]}
        menu={{
          label: "Task options",
          items: taskMenuItems(task, { afterDelete: () => router.back() }),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          ...page,
          paddingTop: space.sm,
          paddingBottom: (bar ? chrome.bottom : 0) + space["2xl"],
        }}
      >
        {editing ? (
          <View style={{ gap: space.md }}>
            <TextInput
              underlineColorAndroid="transparent"
              accessibilityLabel="Title"
              placeholder="Task title"
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              value={draft.title}
              onChangeText={(title) => setDraft((d) => ({ ...d, title }))}
              multiline
              maxLength={300}
              style={[type.title, { letterSpacing: 0, color: colors.ink, padding: 0 }]}
            />
            <TextInput
              underlineColorAndroid="transparent"
              accessibilityLabel="Description, Markdown"
              placeholder={"Describe the task. Add acceptance criteria as a checklist:\n- [ ] Done when…"}
              placeholderTextColor={colors.muted}
              selectionColor={colors.accent}
              value={draft.body}
              onChangeText={(body) => setDraft((d) => ({ ...d, body }))}
              multiline
              autoFocus
              textAlignVertical="top"
              scrollEnabled={false}
              style={[
                type.body,
                {
                  letterSpacing: 0,
                  color: colors.ink,
                  minHeight: 240,
                  padding: space.lg,
                  borderRadius: radius.md,
                  backgroundColor: colors.surface,
                },
              ]}
            />
            <T variant="footnote" tone="muted">
              Checklist lines (- [ ]) become the acceptance criteria.
            </T>
          </View>
        ) : (
          <>
            <T variant="title" selectable>
              {taskTitle(task)}
            </T>
            <T
              variant="footnote"
              tone="secondary"
              style={{ marginTop: space.xs, fontVariant: ["tabular-nums"] }}
            >
              {`${task.key} · ${agoPhrase("Created", task.created_at, now)}`}
            </T>
            <InsetGroup style={{ marginTop: space.xl }}>
              <ListRow
                title="Status"
                leading={<StatusGlyph status={task.status} size={16} animated={live} />}
                value={STATUS_LABEL[task.status]}
                valueMenu={statusMenuItems(task)}
                disabled={!connected}
              />
              <ListRow
                title="Priority"
                leading={<PriorityGlyph priority={task.priority} size={16} />}
                value={PRIORITY_LABEL[task.priority]}
                valueMenu={priorityMenuItems(task)}
                disabled={!connected}
              />
              <ListRow
                title="Project"
                leading={<ProjectDot projectId={task.project_id} size={8} />}
                value={where}
              />
            </InsetGroup>
            {!isUserStatus(task.status) && (
              <SectionFooter inset>{`${STATUS_LABEL[task.status]} follows the latest run.`}</SectionFooter>
            )}

            <SectionHeader title="Description" inset />
            <InsetGroup>
              <View style={{ padding: space.lg }}>
                {parts.description ? (
                  <Markdown text={parts.description} />
                ) : (
                  <T tone="muted">No description. Tap Edit to add one.</T>
                )}
              </View>
            </InsetGroup>

            {parts.criteria.length > 0 && (
              <>
                <SectionHeader title="Acceptance criteria" inset />
                <InsetGroup>
                  {parts.criteria.map((criterion, index) => (
                    <ListRow
                      key={`${index}:${criterion.text}`}
                      title={plainInline(criterion.text)}
                      titleLines={4}
                      leading={<Check checked={criterion.checked} size={22} />}
                      label={`${plainInline(criterion.text)}, ${criterion.checked ? "done" : "not done"}`}
                      disabled={!connected}
                      onPress={() => {
                        haptics.select();
                        attempt(() =>
                          toggleTaskCriterion(task.id, index).catch(async (e) => {
                            await fetchTask(task.id).catch(() => {});
                            throw e;
                          }),
                        );
                      }}
                    />
                  ))}
                </InsetGroup>
                <SectionFooter inset>{`${done} of ${parts.criteria.length} done`}</SectionFooter>
              </>
            )}

            {linked.length > 0 && (
              <>
                <SectionHeader title="Linked notes" count={linked.length} inset />
                <InsetGroup>
                  {linked.map(({ id: noteId, note }) => (
                    <ListRow
                      key={noteId}
                      title={note ? noteTitle(note) : "Note unavailable"}
                      leading="doc.text"
                      meta={note ? checklistBadge(note) || undefined : undefined}
                      chevron={!!note && !note.deleted_at}
                      disabled={!note || !!note.deleted_at}
                      onPress={() => router.push({ pathname: "/note", params: { id: noteId } })}
                    />
                  ))}
                </InsetGroup>
              </>
            )}

            {runs.length > 0 && (
              <>
                <SectionHeader title="Runs" count={runs.length} inset />
                <InsetGroup>
                  {runs.map((item) => {
                    const agent = agentName(item);
                    const model = item.model ? ` ${item.model.replace(/^Claude\s+/i, "")}` : "";
                    const outcome = [runOutcome(item, now), item.diff ? diffLabel(item.diff) : ""]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <ListRow
                        key={item.thread_id}
                        title={`Run ${item.number} · ${agent}${model}`}
                        subtitle={outcome}
                        leading={<ProviderMark kind={item.provider.kind} size={16} color={colors.secondary} />}
                        meta={ageLabel(item.started_at, now)}
                        chevron
                        label={`Run ${item.number}, ${agent}, ${outcome}. Open run`}
                        onPress={() => openThread(item.thread_id)}
                      />
                    );
                  })}
                </InsetGroup>
              </>
            )}

            {task.pending_followup?.trim() ? (
              <>
                <SectionHeader
                  title="For the next run"
                  action={{
                    title: "Clear",
                    label: "Clear the saved message",
                    onPress: () => attempt(() => clearPendingFollowup(task.id)),
                  }}
                  inset
                />
                <InsetGroup>
                  <View style={{ padding: space.lg }}>
                    <T selectable>{task.pending_followup}</T>
                  </View>
                </InsetGroup>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
      {bar && <ActionBar task={task} connected={connected} />}
      <TaskToast bottom={bar ? Math.max(0, chrome.bottom - insets.bottom) : 0} />
    </KeyboardAvoidingView>
  );
}

export default function TaskScreen() {
  return (
    <ChromeProvider>
      <TaskPage />
    </ChromeProvider>
  );
}
