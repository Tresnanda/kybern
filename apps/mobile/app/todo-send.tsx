import * as Haptics from "expo-haptics";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { openThread } from "../src/features/taskActions";
import { getDraft } from "../src/state/draft";
import { useNotes } from "../src/state/notes";
import { noteTitle } from "../src/state/notesModel";
import type { ProviderKind } from "../src/state/protocol";
import { errorText, rpc, useApp } from "../src/state/runtime";
import { sendTask, showToast, useTask } from "../src/state/tasks";
import {
  approxTokens,
  buildTaskPrompt,
  formatTokens,
  modelLabel,
  sendDefaults,
  taskTitle,
  type SendDefaults,
} from "../src/state/tasksModel";
import { Alert } from "../src/ui/Alert";
import { ProviderMark } from "../src/ui/ProviderMark";
import { Button, Icon, styles, T, Tap } from "../src/ui/primitives";
import { ProjectDot } from "../src/ui/TaskGlyphs";
import { type, useTheme } from "../src/ui/theme";
import { findModel } from "../../../packages/kybern-client/src/models";

function Choice({
  label,
  detail,
  leading,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  leading?: ReactNode;
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
      style={[styles.line, { gap: 12, paddingHorizontal: 14, paddingVertical: 4 }]}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <T variant="label" style={{ fontWeight: "400" }} numberOfLines={1}>
          {label}
        </T>
        {detail ? (
          <T variant="caption" tone="secondary" numberOfLines={1}>
            {detail}
          </T>
        ) : null}
      </View>
      {selected && <Icon name="checkmark" size={15} color={colors.accent} />}
    </Tap>
  );
}

function Heading({ children, aside }: { children: string; aside?: ReactNode }) {
  return (
    <View style={[styles.spread, { marginTop: 24, marginBottom: 6, minHeight: 24 }]}>
      <T variant="label" accessibilityRole="header">
        {children}
      </T>
      {aside}
    </View>
  );
}

export default function SendTask() {
  const { id = "" } = useLocalSearchParams<{ id: string }>();
  const app = useApp();
  const task = useTask(id);
  const { notes } = useNotes();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const global = !task?.project_id;
  const [chosenProject, setChosenProject] = useState<string | null>(() =>
    app.projects.length === 1 ? app.projects[0]!.id : null,
  );
  const projectId = task?.project_id ?? chosenProject;
  const project = app.projects.find((p) => p.id === projectId);
  const isGit = !!project?.is_git;

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
  const [expanded, setExpanded] = useState(false);

  // Linked notes, plus the note the task came from, go along unless unchecked.
  const contextIds = useMemo(() => {
    if (!task) return [];
    const ids = [...task.note_ids];
    if (task.source_note_id && !ids.includes(task.source_note_id))
      ids.push(task.source_note_id);
    return ids;
  }, [task]);
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

  const initialPrompt = useMemo(() => (task ? buildTaskPrompt(task) : ""), [task?.id]);
  const [prompt, setPrompt] = useState(initialPrompt);
  useEffect(() => setPrompt(initialPrompt), [initialPrompt]);
  const [busy, setBusy] = useState<"" | "start" | "open">("");

  if (!task)
    return (
      <View style={{ flex: 1, padding: 24 }}>
        <T tone="secondary">This task is no longer here.</T>
      </View>
    );

  const providers = app.providers.filter((p) => p.available);
  const provider = app.providers.find((p) => p.kind === config.provider);
  const model = findModel(provider?.models ?? [], config.model);
  const agentName = provider?.display_name ?? config.provider;
  const workspace = !project
    ? ""
    : !isGit
      ? "Project folder"
      : config.worktree
        ? "New worktree"
        : "Local checkout";
  const summary = [
    agentName,
    model ? modelLabel(config.provider, model.display_name) : config.model || "",
    workspace,
  ]
    .filter(Boolean)
    .join(" · ");
  const selectedNotes = contextIds.filter((n) => !unchecked.has(n));
  const total = selectedNotes.reduce((sum, n) => sum + (sizes[n] ?? 0), 0);
  const ready =
    !!provider?.available && !!projectId && !!prompt.trim() && app.status === "open";

  function chooseProvider(kind: ProviderKind) {
    const next = app.providers.find((p) => p.kind === kind);
    if (!next) return;
    void Haptics.selectionAsync();
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
    try {
      const result = await sendTask({
        id: task!.id,
        provider: { kind: config.provider, instance: config.instance },
        model: config.model || null,
        effort: config.effort || null,
        permission_mode: config.permission,
        use_worktree: isGit ? config.worktree : false,
        project_id: global ? projectId : null,
        prompt: prompt.trim(),
        note_ids: selectedNotes,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.dismiss();
      if (open) openThread(result.thread_id);
      else
        showToast(`${task!.key} started`, {
          kind: "open",
          threadId: result.thread_id,
        });
    } catch (e) {
      Alert.alert("Unable to start the task", errorText(e), [{ text: "OK" }]);
      setBusy("");
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: "Send to agent" }} />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 4,
          paddingBottom: insets.bottom + 24,
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
        }}
      >
        <T tone="secondary" numberOfLines={2}>
          <T tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
            {task.key}
          </T>
          {`  ${taskTitle(task)}`}
        </T>

        {global && (
          <>
            <Heading>Project</Heading>
            <T variant="caption" tone="secondary" style={{ marginBottom: 6 }}>
              This is a Global task. Choose where the agent works.
            </T>
            <View style={{ borderRadius: 15, backgroundColor: colors.raised, paddingVertical: 4 }}>
              {app.projects.map((p) => (
                <Choice
                  key={p.id}
                  label={p.name}
                  leading={<ProjectDot projectId={p.id} size={8} />}
                  selected={p.id === projectId}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setChosenProject(p.id);
                  }}
                />
              ))}
            </View>
          </>
        )}

        <Tap
          label={`Agent: ${summary}. ${expanded ? "Hide" : "Change"} agent, model and workspace`}
          expanded={expanded}
          static
          onPress={() => setExpanded((v) => !v)}
          style={[
            styles.line,
            {
              marginTop: 20,
              gap: 10,
              paddingHorizontal: 14,
              minHeight: 52,
              borderRadius: 15,
              backgroundColor: colors.raised,
            },
          ]}
        >
          <ProviderMark kind={config.provider} size={17} color={colors.ink} />
          <T variant="label" style={{ flex: 1, fontWeight: "400" }} numberOfLines={1}>
            {summary || "Choose an agent"}
          </T>
          <Icon name={expanded ? "chevron.up" : "chevron.down"} size={12} color={colors.muted} />
        </Tap>
        {expanded && (
          <View>
            <Heading>Agent</Heading>
            {providers.map((p) => (
              <Choice
                key={p.kind}
                label={p.display_name}
                leading={<ProviderMark kind={p.kind} size={17} color={colors.secondary} />}
                selected={p.kind === config.provider}
                onPress={() => chooseProvider(p.kind)}
              />
            ))}
            {!providers.length && (
              <T variant="caption" tone="secondary">
                Set up an agent on your computer to send tasks.
              </T>
            )}
            {(provider?.models?.length ?? 0) > 0 && (
              <>
                <Heading>Model</Heading>
                <Choice
                  label="Agent default"
                  selected={!config.model}
                  onPress={() => setConfig((c) => ({ ...c, model: "", effort: "" }))}
                />
                {provider!.models!.map((m) => (
                  <Choice
                    key={m.id}
                    label={modelLabel(config.provider, m.display_name)}
                    selected={model?.id === m.id}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setConfig((c) => ({ ...c, model: m.id, effort: m.default_effort ?? "" }));
                    }}
                  />
                ))}
              </>
            )}
            {isGit && (
              <>
                <Heading>Workspace</Heading>
                <Choice
                  label="New worktree"
                  detail="Keeps this run’s changes in a separate checkout."
                  selected={config.worktree}
                  onPress={() => setConfig((c) => ({ ...c, worktree: true }))}
                />
                <Choice
                  label="Local checkout"
                  detail={`Works directly in ${project?.name ?? "the project"}.`}
                  selected={!config.worktree}
                  onPress={() => setConfig((c) => ({ ...c, worktree: false }))}
                />
              </>
            )}
          </View>
        )}

        {contextIds.length > 0 && (
          <>
            <Heading
              aside={
                total > 0 ? (
                  <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                    About {formatTokens(total)} tokens
                  </T>
                ) : undefined
              }
            >
              Context
            </Heading>
            {contextIds.map((noteId) => {
              const note = notes.find((n) => n.id === noteId);
              const on = !unchecked.has(noteId);
              const name = note ? noteTitle(note) : "Note";
              return (
                <Tap
                  key={noteId}
                  label={`Include ${name}`}
                  selected={on}
                  static
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setUnchecked((s) => {
                      const next = new Set(s);
                      if (on) next.add(noteId);
                      else next.delete(noteId);
                      return next;
                    });
                  }}
                  style={[styles.line, { gap: 12 }]}
                >
                  <Icon
                    name={on ? "checkmark.square.fill" : "square"}
                    size={19}
                    color={on ? colors.ink : colors.muted}
                  />
                  <T variant="label" style={{ flex: 1, fontWeight: "400" }} numberOfLines={1}>
                    {name}
                  </T>
                  {sizes[noteId] ? (
                    <T variant="caption" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                      {formatTokens(sizes[noteId]!)}
                    </T>
                  ) : null}
                </Tap>
              );
            })}
          </>
        )}

        <Heading
          aside={
            prompt !== initialPrompt ? (
              <Tap label="Reset prompt" onPress={() => setPrompt(initialPrompt)} style={{ minHeight: 32 }}>
                <T variant="caption" tone="accent">
                  Reset
                </T>
              </Tap>
            ) : undefined
          }
        >
          Prompt
        </Heading>
        <TextInput
          underlineColorAndroid="transparent"
          accessibilityLabel="Prompt"
          value={prompt}
          onChangeText={setPrompt}
          multiline
          textAlignVertical="top"
          scrollEnabled={false}
          selectionColor={colors.accent}
          style={[
            type.body,
            {
              color: colors.ink,
              fontSize: 15,
              lineHeight: 22,
              minHeight: 140,
              padding: 14,
              borderRadius: 15,
              backgroundColor: colors.raised,
            },
          ]}
        />

        <View style={{ marginTop: 24, gap: 10 }}>
          <Button busy={busy === "start"} disabled={!ready || !!busy} onPress={() => void start(false)}>
            Start
          </Button>
          <Button
            secondary
            busy={busy === "open"}
            disabled={!ready || !!busy}
            onPress={() => void start(true)}
          >
            Start and open
          </Button>
          <T variant="caption" tone="muted" style={{ textAlign: "center", marginTop: 2 }}>
            {!projectId
              ? "Choose a project to start."
              : "Runs in the background on your computer."}
          </T>
        </View>
      </ScrollView>
    </View>
  );
}
