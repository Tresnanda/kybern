import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ModeToggle } from "../src/features/NoteView";
import {
  attempt,
  changePriority,
  changeStatus,
  openSend,
  openThread,
  taskMenu,
} from "../src/features/taskActions";
import { useMinuteClock } from "../src/features/TaskRow";
import { TaskToast } from "../src/features/TaskToast";
import { useNotes } from "../src/state/notes";
import { checklistBadge, noteTitle } from "../src/state/notesModel";
import type { TaskItem, TaskRun, TaskStatus } from "../src/state/protocol";
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
  PRIORITY_MENU_ORDER,
  STATUS_LABEL,
  TASKS_CONFLICT,
  USER_STATUSES,
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
import { Markdown } from "../src/ui/Markdown";
import { ProviderMark } from "../src/ui/ProviderMark";
import {
  Button,
  Empty,
  Icon,
  IconButton,
  styles,
  T,
  Tap,
} from "../src/ui/primitives";
import { PriorityGlyph, ProjectDot, StatusGlyph } from "../src/ui/TaskGlyphs";
import { type, useTheme } from "../src/ui/theme";

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "OMP",
};

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ marginTop: 32, gap: 4 }}>
      <View style={[styles.line, { gap: 8, marginBottom: 4 }]}>
        <T variant="label" accessibilityRole="header">
          {title}
        </T>
        {aside ? (
          <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {aside}
          </T>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** A property line: quiet label, value with its glyph, and inline choices when open. */
function Property({
  label,
  value,
  glyph,
  open,
  onToggle,
  disabled,
  readOnly,
  children,
}: {
  label: string;
  value: string;
  glyph: ReactNode;
  open: boolean;
  onToggle: () => void;
  disabled?: boolean;
  /** Shown as plain text, not a control. */
  readOnly?: boolean;
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const line = (
    <>
      <T variant="caption" tone="secondary" style={{ width: 84 }}>
        {label}
      </T>
      <View style={[styles.line, { gap: 9, flex: 1 }]}>
        {glyph}
        <T variant="label" style={{ fontWeight: "400", flexShrink: 1 }} numberOfLines={1}>
          {value}
        </T>
      </View>
    </>
  );
  return (
    <View>
      {readOnly ? (
        <View
          accessible
          accessibilityLabel={`${label}: ${value}`}
          style={[styles.line, { gap: 0, minHeight: 44 }]}
        >
          {line}
        </View>
      ) : (
        <Tap
          label={`${label}: ${value}`}
          expanded={open}
          static
          disabled={disabled}
          onPress={onToggle}
          style={[styles.line, { gap: 0, minHeight: 44 }]}
        >
          {line}
          <Icon name={open ? "chevron.up" : "chevron.down"} size={11} color={colors.muted} />
        </Tap>
      )}
      {open && (
        <View
          style={{
            marginStart: 84,
            marginBottom: 8,
            paddingVertical: 4,
            borderRadius: 15,
            backgroundColor: colors.raised,
          }}
        >
          {children}
        </View>
      )}
    </View>
  );
}

function Choice({
  label,
  glyph,
  selected,
  onPress,
}: {
  label: string;
  glyph: ReactNode;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Tap
      label={label}
      selected={selected}
      static
      onPress={onPress}
      style={[styles.line, { gap: 10, paddingHorizontal: 14 }]}
    >
      {glyph}
      <T variant="label" style={{ flex: 1, fontWeight: "400" }}>
        {label}
      </T>
      {selected && <Icon name="checkmark" size={15} color={colors.accent} />}
    </Tap>
  );
}

function RunRow({ run, now }: { run: TaskRun; now: number }) {
  const app = useApp();
  const { colors } = useTheme();
  const agent =
    app.providers.find((p) => p.kind === run.provider.kind)?.display_name ??
    AGENT_NAMES[run.provider.kind] ??
    run.provider.kind;
  const live = isLiveRun(run);
  const outcome = [runOutcome(run, now), run.diff ? diffLabel(run.diff) : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={{ gap: 6 }}>
      <Tap
        label={`Run ${run.number}, ${agent}, ${outcome}. Open run`}
        static
        onPress={() => openThread(run.thread_id)}
        style={[styles.line, { gap: 12, alignItems: "flex-start", paddingVertical: 8 }]}
      >
        <View style={{ paddingTop: 3 }}>
          <ProviderMark kind={run.provider.kind} size={15} color={colors.secondary} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label" style={{ fontWeight: "400" }} numberOfLines={1}>
            Run {run.number}
            <T variant="label" tone="secondary" style={{ fontWeight: "400" }}>
              {` · ${agent}${run.model ? ` ${run.model.replace(/^Claude\s+/i, "")}` : ""}`}
            </T>
          </T>
          <T variant="caption" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
            {outcome}
          </T>
        </View>
        <T variant="caption" tone="muted" style={{ paddingTop: 2, fontVariant: ["tabular-nums"] }}>
          {ageLabel(run.started_at, now)}
        </T>
      </Tap>
      {live && (
        <Tap
          label="Open run"
          static
          onPress={() => openThread(run.thread_id)}
          style={[
            styles.line,
            {
              marginStart: 27,
              gap: 10,
              paddingStart: 14,
              paddingEnd: 8,
              borderRadius: 15,
              backgroundColor: colors.raised,
            },
          ]}
        >
          <StatusGlyph status="running" size={14} animated />
          <T variant="caption" tone="secondary" numberOfLines={2} style={{ flex: 1 }}>
            {run.state === "waiting" ? "Waiting for your answer" : (run.activity ?? "Working")}
          </T>
          <T variant="label" style={{ paddingHorizontal: 8 }}>
            Open run
          </T>
        </Tap>
      )}
    </View>
  );
}

/** Sends into the latest run's thread when it can take one, otherwise saves it for the next run. */
function Followup({ task }: { task: TaskItem }) {
  const app = useApp();
  const { colors } = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = latestRun(task);
  const thread = run ? app.threads.find((t) => t.id === run.thread_id) : undefined;
  const busyThread =
    thread?.status === "running" || thread?.status === "awaiting-approval" || isLiveRun(run);
  const placeholder = !run
    ? "Add context for the next run…"
    : busyThread
      ? `Queue a follow-up for Run ${run.number}…`
      : `Send a follow-up to Run ${run.number}…`;
  const send = () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    void followupTask(task.id, value)
      .then((result) => {
        setText("");
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        if (result.sent_to)
          showToast(
            `Sent to Run ${latestRun(result.task)?.number ?? ""}`.trim(),
            { kind: "open", threadId: result.sent_to },
          );
        else showToast("Saved for the next run");
      })
      .catch((e) =>
        Alert.alert("Unable to send the follow-up", errorText(e), [{ text: "OK" }]),
      )
      .finally(() => setBusy(false));
  };
  return (
    <View style={{ marginTop: 32, gap: 10 }}>
      {task.pending_followup?.trim() ? (
        <View style={{ gap: 4 }}>
          <View style={styles.spread}>
            <T variant="caption" tone="secondary">
              For the next run
            </T>
            <Tap
              label="Clear saved follow-up"
              onPress={() => attempt(() => clearPendingFollowup(task.id))}
              style={{ paddingHorizontal: 4 }}
            >
              <T variant="caption" tone="accent">
                Clear
              </T>
            </Tap>
          </View>
          <T selectable>{task.pending_followup}</T>
        </View>
      ) : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 4,
          paddingStart: 16,
          paddingEnd: 4,
          paddingVertical: 2,
          borderRadius: 22,
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
          style={[
            type.body,
            { color: colors.ink, flex: 1, minHeight: 44, maxHeight: 180, paddingTop: 10, paddingBottom: 10 },
          ]}
        />
        <IconButton
          name="arrow.up"
          label={run && !busyThread ? `Send to Run ${run.number}` : "Save follow-up"}
          filled={!!text.trim()}
          disabled={!text.trim() || busy}
          onPress={send}
        />
      </View>
    </View>
  );
}

export default function TaskScreen() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const { loaded } = useTasks();
  const task = useTask(id);
  const { notes } = useNotes();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  const connected = app.status === "open";
  const [open, setOpen] = useState<"" | "status" | "priority" | "project">("");
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

  if (!task)
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, paddingHorizontal: 24 }}>
        <Stack.Screen options={{ title: "" }} />
        {missing ? (
          <Empty
            icon="checklist"
            title="This task is gone"
            detail="It was deleted, or it belongs to another computer."
            action={<Button onPress={() => router.back()}>Go back</Button>}
          />
        ) : (
          <T variant="caption" tone="secondary" style={{ paddingVertical: 24 }}>
            {connected ? "Loading task…" : "Connect your computer to open this task."}
          </T>
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
      setOpen("");
      setEditing(true);
      return;
    }
    void save(draftRef.current).then((ok) => {
      if (ok) setEditing(false);
    });
  }

  const statusGlyph = (status: TaskStatus) => <StatusGlyph status={status} size={16} />;
  const where = task.project_id
    ? (project?.name ?? "Project")
    : `Global · on ${activeEnvironment()?.name ?? "your computer"}`;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          title: task.key,
          headerRight: () => (
            <View style={styles.line}>
              <ModeToggle
                editing={editing}
                onChange={setMode}
                disabled={!connected || saving}
              />
              <IconButton
                name="ellipsis"
                label="Task options"
                onPress={() => taskMenu(task, { afterDelete: () => router.back() })}
              />
            </View>
          ),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: insets.bottom + 96,
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
        }}
      >
        {editing ? (
          <View style={{ gap: 14 }}>
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
              style={[type.title, { color: colors.ink, padding: 0 }]}
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
              style={[type.body, { color: colors.ink, padding: 0, minHeight: 240 }]}
            />
            <T variant="caption" tone="muted">
              Checklist lines (- [ ]) become the acceptance criteria.
            </T>
          </View>
        ) : (
          <>
            <T variant="title" selectable style={{ letterSpacing: -0.6 }}>
              {taskTitle(task)}
            </T>
            <View style={{ marginTop: 16 }}>
              <Property
                label="Status"
                value={STATUS_LABEL[task.status]}
                glyph={<StatusGlyph status={task.status} size={16} animated={live} />}
                open={open === "status"}
                disabled={!connected}
                onToggle={() => setOpen(open === "status" ? "" : "status")}
              >
                {USER_STATUSES.map((status) => (
                  <Choice
                    key={status}
                    label={STATUS_LABEL[status]}
                    glyph={statusGlyph(status)}
                    selected={task.status === status}
                    onPress={() => {
                      setOpen("");
                      if (status !== task.status) changeStatus(task, status);
                    }}
                  />
                ))}
                {!isUserStatus(task.status) && (
                  <T variant="caption" tone="muted" style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
                    {STATUS_LABEL[task.status]} follows the latest run.
                  </T>
                )}
              </Property>
              <Property
                label="Priority"
                value={PRIORITY_LABEL[task.priority]}
                glyph={<PriorityGlyph priority={task.priority} size={16} />}
                open={open === "priority"}
                disabled={!connected}
                onToggle={() => setOpen(open === "priority" ? "" : "priority")}
              >
                {PRIORITY_MENU_ORDER.map((priority) => (
                  <Choice
                    key={priority}
                    label={PRIORITY_LABEL[priority]}
                    glyph={<PriorityGlyph priority={priority} size={16} />}
                    selected={task.priority === priority}
                    onPress={() => {
                      setOpen("");
                      if (priority !== task.priority) changePriority(task, priority);
                    }}
                  />
                ))}
              </Property>
              <Property
                label="Project"
                value={where}
                glyph={
                  <View style={{ width: 16, alignItems: "center" }}>
                    <ProjectDot projectId={task.project_id} size={8} />
                  </View>
                }
                open={false}
                readOnly
                onToggle={() => {}}
              />
            </View>
            <View style={{ marginTop: 20, gap: 10 }}>
              {run && (live || task.status === "needs_review") ? (
                <Button icon="text.bubble" onPress={() => openThread(run.thread_id)}>
                  {`Open run ${run.number}`}
                </Button>
              ) : null}
              {!live && (
                <Button
                  icon="paperplane"
                  secondary={task.status === "needs_review"}
                  disabled={!connected}
                  onPress={() => openSend(task.id)}
                >
                  {run ? "Send to agent again" : "Send to agent"}
                </Button>
              )}
            </View>
            <View style={{ marginTop: 28 }}>
              {parts.description ? (
                <Markdown text={parts.description} />
              ) : (
                <T tone="muted">No description. Tap Edit to add one.</T>
              )}
            </View>
            {parts.criteria.length > 0 && (
              <Section
                title="Acceptance criteria"
                aside={`${done} of ${parts.criteria.length}`}
              >
                {parts.criteria.map((criterion, index) => (
                  <Tap
                    key={`${index}:${criterion.text}`}
                    label={plainInline(criterion.text)}
                    selected={criterion.checked}
                    static
                    disabled={!connected}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      attempt(() =>
                        toggleTaskCriterion(task.id, index).catch(async (e) => {
                          await fetchTask(task.id).catch(() => {});
                          throw e;
                        }),
                      );
                    }}
                    style={{ flexDirection: "row", alignItems: "flex-start", gap: 12, paddingVertical: 8 }}
                  >
                    <View style={{ paddingTop: 2 }}>
                      <Icon
                        name={criterion.checked ? "checkmark.square.fill" : "square"}
                        size={19}
                        color={criterion.checked ? colors.secondary : colors.muted}
                      />
                    </View>
                    <T
                      tone={criterion.checked ? "secondary" : "ink"}
                      style={{ flex: 1, fontSize: 16, lineHeight: 23 }}
                    >
                      {plainInline(criterion.text)}
                    </T>
                  </Tap>
                ))}
              </Section>
            )}
            {linked.length > 0 && (
              <Section title="Linked notes">
                {linked.map(({ id: noteId, note }) => (
                  <Tap
                    key={noteId}
                    label={note ? `Open note ${noteTitle(note)}` : "Note unavailable"}
                    static
                    disabled={!note || !!note.deleted_at}
                    onPress={() => router.push({ pathname: "/note", params: { id: noteId } })}
                    style={[styles.line, { gap: 12 }]}
                  >
                    <Icon name="doc.text" size={17} color={colors.secondary} />
                    <T variant="label" style={{ flex: 1, fontWeight: "400" }} numberOfLines={1}>
                      {note ? noteTitle(note) : "Note unavailable"}
                    </T>
                    {note && checklistBadge(note) ? (
                      <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                        {checklistBadge(note)}
                      </T>
                    ) : null}
                  </Tap>
                ))}
              </Section>
            )}
            {runs.length > 0 && (
              <Section title="Runs">
                {runs.map((item) => (
                  <RunRow key={item.thread_id} run={item} now={now} />
                ))}
              </Section>
            )}
            {connected && <Followup task={task} />}
            <T variant="caption" tone="muted" style={{ marginTop: 24, fontVariant: ["tabular-nums"] }}>
              {`Created ${ageLabel(task.created_at, now)} ago`.replace("now ago", "just now")}
            </T>
          </>
        )}
      </ScrollView>
      <TaskToast />
    </KeyboardAvoidingView>
  );
}

