import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openThread } from "../src/features/taskActions";
import { getDraft } from "../src/state/draft";
import { count } from "../src/state/format";
import { useNotes } from "../src/state/notes";
import { noteTitle } from "../src/state/notesModel";
import type { ProviderKind, TaskBatchMode, TaskItem } from "../src/state/protocol";
import { activeEnvironment, errorText, rpc, useApp } from "../src/state/runtime";
import { fetchTask, sendTask, sendTasks, showToast, useTasks } from "../src/state/tasks";
import {
  approxTokens,
  batchPrompt,
  buildTaskPrompt,
  formatTokens,
  modelLabel,
  sendBlocker,
  sendDefaults,
  taskTitle,
  type SendDefaults,
} from "../src/state/tasksModel";
import { Alert } from "../src/ui/Alert";
import { Check } from "../src/ui/CheckRow";
import { haptics } from "../src/ui/haptics";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import type { MenuItem } from "../src/ui/menuModel";
import { ProviderMark } from "../src/ui/ProviderMark";
import { Button, T } from "../src/ui/primitives";
import { Segmented } from "../src/ui/Segmented";
import { ProjectDot, StatusGlyph } from "../src/ui/TaskGlyphs";
import {
  CONTENT_MAX_WIDTH,
  gutter,
  maxScale,
  radius,
  space,
  type,
  useTheme,
} from "../src/ui/theme";
import { findModel } from "../../../packages/kybern-client/src/models";
import { supportsWorktree } from "../src/state/groups";

/** One task (`id`) or several (`ids`, comma separated) from the Tasks selection. */
export default function SendTask() {
  const params = useLocalSearchParams<{ id?: string; ids?: string }>();
  const app = useApp();
  const { tasks: all, loaded } = useTasks();
  const { notes } = useNotes();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const ids = useMemo(
    () => (params.ids ? params.ids.split(",").filter(Boolean) : params.id ? [params.id] : []),
    [params.id, params.ids],
  );
  const tasks = useMemo(
    () => ids.flatMap((id) => all.filter((t) => t.id === id)),
    [ids, all],
  );
  const task: TaskItem | undefined = tasks[0];
  // Opened from a link before the list arrived: fetch the tasks it names.
  useEffect(() => {
    if (app.status !== "open") return;
    for (const id of ids) if (!all.some((t) => t.id === id)) void fetchTask(id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, app.status]);
  const batch = ids.length > 1;
  const [mode, setMode] = useState<TaskBatchMode>("separate");
  const projectIds = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))] as string[];
  const anyGlobal = tasks.some((t) => !t.project_id);
  const [chosenProject, setChosenProject] = useState<string | null>(() =>
    app.projects.length === 1 ? app.projects[0]!.id : null,
  );
  // Global tasks run where you choose; a project's tasks run in their own project.
  const projectId = anyGlobal ? chosenProject : (projectIds[0] ?? null);
  const project = app.projects.find((p) => p.id === projectId);
  // Group projects run in their member repositories even when the group folder is not one.
  const isGit = supportsWorktree(project);
  const mixedProjects =
    batch && mode === "combined" && (projectIds.length > 1 || (projectIds.length === 1 && anyGlobal && chosenProject !== projectIds[0]));

  const defaults = useMemo<SendDefaults>(() => {
    const draft = getDraft();
    return sendDefaults({
      projectId,
      isGit,
      threads: app.threads,
      providers: app.providers,
      fallback: {
        provider: draft.provider,
        instance: draft.instance,
        model: draft.model,
        effort: draft.effort,
        permission: draft.permission,
        worktree: draft.worktree,
      },
    });
    // Recomputed per project; later thread or provider updates keep your choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, isGit, app.providers.length]);
  const [config, setConfig] = useState(defaults);
  useEffect(() => setConfig(defaults), [defaults]);

  // Linked notes, plus the note a task came from, go along unless unchecked.
  const contextIds = useMemo(() => {
    const out: string[] = [];
    for (const t of tasks)
      for (const noteId of [...t.note_ids, ...(t.source_note_id ? [t.source_note_id] : [])])
        if (!out.includes(noteId)) out.push(noteId);
    return out;
  }, [tasks]);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [sizes, setSizes] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    for (const noteId of contextIds)
      void rpc("notes.get", { id: noteId })
        .then(({ note }) => {
          if (alive && note)
            setSizes((s) => ({
              ...s,
              [noteId]: approxTokens(note.title.length + note.body.length),
            }));
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [contextIds]);

  const initialPrompt = useMemo(
    () => (batch ? batchPrompt(mode) : task ? buildTaskPrompt(task) : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task?.id, batch, mode],
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [edited, setEdited] = useState(false);
  useEffect(() => {
    if (!edited) setPrompt(initialPrompt);
  }, [initialPrompt, edited]);
  const [busy, setBusy] = useState<"" | "start" | "open">("");

  const page = {
    paddingHorizontal: gutter(width),
    width: "100%" as const,
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center" as const,
  };
  if (!task)
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ ...page, paddingTop: space.xl }}
      >
        <T tone="secondary">
          {!loaded
            ? "Loading…"
            : batch
              ? "These tasks are no longer here."
              : "This task is no longer here."}
        </T>
      </ScrollView>
    );

  const computer = activeEnvironment()?.name ?? "your computer";
  const providers = app.providers.filter((p) => p.available);
  const provider = app.providers.find((p) => p.kind === config.provider);
  const model = findModel(provider?.models ?? [], config.model);
  const agentName = provider?.display_name ?? config.provider;
  const selectedNotes = contextIds.filter((n) => !unchecked.has(n));
  const total = selectedNotes.reduce((sum, n) => sum + (sizes[n] ?? 0), 0);
  const blocker = sendBlocker({
    connected: app.status === "open",
    computer,
    anyAgent: providers.length > 0,
    agentReady: !!provider?.available,
    agentName,
    hasProject: !!projectId,
    mixedProjects: !!mixedProjects,
    prompt,
  });
  const ready = !blocker;

  function chooseProvider(kind: ProviderKind) {
    const next = app.providers.find((p) => p.kind === kind);
    if (!next) return;
    haptics.select();
    setConfig((c) => ({
      ...c,
      provider: kind,
      instance: next.instances[0] ?? "default",
      model: "",
      effort: "",
      permission: next.supported_permission_modes.includes(c.permission)
        ? c.permission
        : (next.supported_permission_modes[0] ?? c.permission),
    }));
  }

  async function start(open: boolean) {
    if (!ready || busy) return;
    setBusy(open ? "open" : "start");
    const common = {
      provider: { kind: config.provider, instance: config.instance },
      model: config.model || null,
      effort: config.effort || null,
      permission_mode: config.permission,
      use_worktree: isGit ? config.worktree : false,
      project_id: anyGlobal ? projectId : null,
      prompt: prompt.trim(),
      note_ids: selectedNotes,
    };
    try {
      let threadId: string;
      let text: string;
      if (batch) {
        const result = await sendTasks({ ids, mode, ...common });
        const reasons = result.skipped
          .map((s) => `${all.find((t) => t.id === s.id)?.key ?? "A task"}: ${s.reason}`)
          .join("\n");
        if (!result.started.length) throw new Error(reasons || "No tasks started.");
        threadId = result.started[0]!.thread_id;
        text = result.skipped.length
          ? `${count(result.started.length, "task")} started, ${result.skipped.length} skipped`
          : `${count(result.started.length, "task")} started`;
      } else {
        const result = await sendTask({ id: task!.id, ...common });
        threadId = result.thread_id;
        text = `${task!.key} started`;
      }
      haptics.success();
      router.dismiss();
      if (open) openThread(threadId);
      else showToast(text, { kind: "open", threadId });
    } catch (e) {
      Alert.alert(
        batch ? "Unable to start the tasks" : "Unable to start the task",
        errorText(e),
        [{ text: "OK" }],
      );
      setBusy("");
    }
  }

  const agentItems: MenuItem[] = providers.map((p) => ({
    title: p.display_name,
    checked: p.kind === config.provider,
    onPress: () => chooseProvider(p.kind),
  }));
  const modelItems: MenuItem[] = [
    {
      title: "Agent default",
      checked: !config.model,
      onPress: () => setConfig((c) => ({ ...c, model: "", effort: "" })),
    },
    ...(provider?.models ?? []).map((m) => ({
      title: modelLabel(config.provider, m.display_name),
      checked: model?.id === m.id,
      onPress: () => {
        haptics.select();
        setConfig((c) => ({ ...c, model: m.id, effort: m.default_effort ?? "" }));
      },
    })),
  ];
  const workspaceItems: MenuItem[] = [
    {
      title: "New worktree",
      subtitle: "Keeps the run’s changes in a separate checkout",
      checked: config.worktree,
      onPress: () => setConfig((c) => ({ ...c, worktree: true })),
    },
    {
      title: "Local checkout",
      subtitle: `Works directly in ${project?.name ?? "the project"}`,
      checked: !config.worktree,
      onPress: () => setConfig((c) => ({ ...c, worktree: false })),
    },
  ];
  const projectItems: MenuItem[] = app.projects.map((p) => ({
    title: p.name,
    checked: p.id === projectId,
    onPress: () => {
      haptics.select();
      setChosenProject(p.id);
    },
  }));

  return (
    // A formSheet lays out a root ScrollView; a wrapper View around it left the sheet blank.
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentContainerStyle={{ ...page, paddingTop: space.xs, paddingBottom: insets.bottom + space.xl }}
    >
      <Stack.Screen
        options={{
          title: batch ? `Send ${count(tasks.length, "task")}` : "Send to agent",
          headerStyle: { backgroundColor: colors.grouped },
        }}
      />
      {batch ? (
        <>
          <InsetGroup>
            {tasks.map((t) => (
              <ListRow
                key={t.id}
                title={taskTitle(t)}
                subtitle={t.key}
                leading={<StatusGlyph status={t.status} size={16} />}
              />
            ))}
          </InsetGroup>
          <View style={{ marginTop: space.lg }}>
            <Segmented<TaskBatchMode>
              label="How to run these tasks"
              value={mode}
              onChange={setMode}
              options={[
                { value: "separate", label: "Separate runs" },
                { value: "combined", label: "One run" },
              ]}
            />
          </View>
          <SectionFooter inset>
            {mode === "separate"
              ? "Each task gets its own run, started side by side."
              : "One agent works through every task in one thread."}
          </SectionFooter>
        </>
      ) : (
        <T variant="subhead" tone="secondary" numberOfLines={2}>
          <T variant="subhead" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {task.key}
          </T>
          {`  ${taskTitle(task)}`}
        </T>
      )}

      <SectionHeader title="Agent" inset />
      <InsetGroup>
        {anyGlobal ? (
          <ListRow
            title="Project"
            leading={<ProjectDot projectId={projectId} size={8} />}
            value={project?.name ?? "Choose"}
            valueMenu={projectItems}
          />
        ) : (
          <ListRow
            title="Project"
            leading={<ProjectDot projectId={projectId} size={8} />}
            value={projectIds.length > 1 ? "Each task’s own" : (project?.name ?? "Project")}
          />
        )}
        <ListRow
          title="Agent"
          leading={<ProviderMark kind={config.provider} size={18} color={colors.ink} />}
          value={providers.length ? agentName : "None set up"}
          valueMenu={providers.length ? agentItems : undefined}
        />
        {(provider?.models?.length ?? 0) > 0 && (
          <ListRow
            title="Model"
            leading="sparkle"
            value={model ? modelLabel(config.provider, model.display_name) : "Agent default"}
            valueMenu={modelItems}
          />
        )}
        {isGit && (
          <ListRow
            title="Workspace"
            leading="arrow.triangle.branch"
            value={config.worktree ? "New worktree" : "Local checkout"}
            valueMenu={workspaceItems}
          />
        )}
      </InsetGroup>

      {contextIds.length > 0 && (
        <>
          <SectionHeader title="Context" inset />
          <InsetGroup>
            {contextIds.map((noteId) => {
              const note = notes.find((n) => n.id === noteId);
              const on = !unchecked.has(noteId);
              const name = note ? noteTitle(note) : "Note";
              return (
                <ListRow
                  key={noteId}
                  title={name}
                  leading={<Check checked={on} size={22} />}
                  meta={sizes[noteId] ? formatTokens(sizes[noteId]!) : undefined}
                  label={`Include ${name}, ${on ? "included" : "left out"}`}
                  onPress={() => {
                    haptics.select();
                    setUnchecked((s) => {
                      const next = new Set(s);
                      if (on) next.add(noteId);
                      else next.delete(noteId);
                      return next;
                    });
                  }}
                />
              );
            })}
          </InsetGroup>
          {total > 0 && <SectionFooter inset>{`About ${formatTokens(total)} tokens of notes go along.`}</SectionFooter>}
        </>
      )}

      <SectionHeader
        title="Prompt"
        action={
          prompt !== initialPrompt
            ? {
                title: "Reset",
                label: "Reset prompt",
                onPress: () => {
                  setEdited(false);
                  setPrompt(initialPrompt);
                },
              }
            : undefined
        }
        inset
      />
      <TextInput
        underlineColorAndroid="transparent"
        accessibilityLabel="Prompt"
        value={prompt}
        onChangeText={(text) => {
          setEdited(true);
          setPrompt(text);
        }}
        multiline
        textAlignVertical="top"
        scrollEnabled={false}
        selectionColor={colors.accent}
        maxFontSizeMultiplier={maxScale("body")}
        style={[
          type.body,
          {
            letterSpacing: 0,
            color: colors.ink,
            minHeight: 140,
            padding: space.lg,
            borderRadius: radius.md,
            backgroundColor: colors.surface,
          },
        ]}
      />
      {batch && (
        <SectionFooter inset>Each task is mentioned at the start of the message.</SectionFooter>
      )}

      <View style={{ marginTop: space.xl, gap: space.sm }}>
        <T
          variant="footnote"
          tone={blocker ? "negative" : "muted"}
          accessibilityLiveRegion="polite"
          style={{ textAlign: "center", marginBottom: space.xs }}
        >
          {blocker || "Runs in the background on your computer."}
        </T>
        <Button
          role="prominent"
          busy={busy === "start"}
          disabled={!ready || !!busy}
          onPress={() => void start(false)}
        >
          Start
        </Button>
        <Button
          role="plain"
          busy={busy === "open"}
          disabled={!ready || !!busy}
          onPress={() => void start(true)}
        >
          Start and open
        </Button>
      </View>
    </ScrollView>
  );
}
