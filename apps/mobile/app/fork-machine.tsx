// "Fork to another machine…" and "Continue on another machine…" (ADE-99 §2.2): pick a machine that has the project, read and
// edit the hand-off note, and send. The daemon does the work (`threads.fork_to_machine`, `threads.move_to_machine`); a machine
// that is away receives it when it is back. Machines without the project are listed disabled and offer Set up project.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { moveParams, moveQueuedText } from "../../../packages/kybern-client/src/continueOn";
import { forkParams, forkQueuedText } from "../../../packages/kybern-client/src/forkMachine";
import { MachinePickerRows } from "../src/features/MachinePicker";
import { machineParity } from "../src/state/machineActions";
import { errorText, machineHub, rpc, useApp, useMachineView, useThread } from "../src/state/runtime";
import { FORK_COPY, threadMachineModel } from "../src/state/threadMachineModel";
import { HeaderActions } from "../src/ui/ActionMenu";
import { haptics } from "../src/ui/haptics";
import { SectionHeader } from "../src/ui/List";
import { Button, Empty, ErrorBanner, Field, T } from "../src/ui/primitives";
import { showToast } from "../src/ui/Toast";
import { space, useTheme } from "../src/ui/theme";

export default function ForkMachine() {
  const { threadId = "", mode } = useLocalSearchParams<{ threadId: string; mode?: string }>();
  const move = mode === "move";
  const app = useApp();
  const view = useMachineView();
  const snapshot = useThread(threadId);
  const { colors } = useTheme();
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const threadMachine = machineHub().machineOfThread(threadId);
  const model = useMemo(
    () => (threadMachine ? threadMachineModel({ machines: view.machines, projects: view.projects, threadMachine, projectId: thread?.project_id, gate: machineParity }) : null),
    // The view changes when a machine's project arrives, which turns a "No checkout" row into a choice.
    [view, threadMachine, thread?.project_id],
  );
  const targets = model?.targets ?? [];
  const [pick, setPick] = useState<string | undefined>();
  const selected = targets.find((t) => !t.missing && t.machineId === pick) ?? targets.find((t) => !t.missing);
  const [generated, setGenerated] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The thread's own machine writes the note; the sheet opens at once and the field fills when it is ready.
  useEffect(() => {
    let live = true;
    rpc("threads.fork_note", { thread_id: threadId }).then(
      (result) => {
        if (!live) return;
        setGenerated(result.note);
        setNote(result.note);
      },
      (e) => {
        if (!live) return;
        setGenerated("");
        setNoteError(FORK_COPY.noteError(errorText(e)));
      },
    );
    return () => {
      live = false;
    };
  }, [threadId]);
  const ready = !!selected && generated !== null && !busy;
  const send = async () => {
    if (!selected || generated === null || busy) return;
    setBusy(true);
    setError("");
    try {
      if (move) {
        const result = await rpc("threads.move_to_machine", moveParams(threadId, selected, { note }, generated));
        showToast(moveQueuedText(result.target_name, selected.online));
      } else {
        const result = await rpc("threads.fork_to_machine", forkParams(threadId, selected, { note, pushOrigin: false }, generated));
        showToast(forkQueuedText(result.target_name, selected.online));
      }
      haptics.success();
      router.back();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  const action = move ? FORK_COPY.moveAction : FORK_COPY.forkAction;
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ title: move ? FORK_COPY.moveTitle : FORK_COPY.forkTitle, headerStyle: { backgroundColor: colors.grouped } }} />
      {Platform.OS === "ios" && <HeaderActions buttons={[{ title: action, prominent: true, disabled: !ready, onPress: () => void send() }]} />}
      <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={{ padding: space.lg, gap: space.lg }}>
        <T variant="subhead" tone="secondary">
          {move ? FORK_COPY.moveHint : FORK_COPY.forkHint}
        </T>
        {targets.length === 0 ? (
          <Empty icon="laptopcomputer" title={FORK_COPY.none} variant="inline" />
        ) : (
          <View>
            <SectionHeader title="Machine" first />
            <MachinePickerRows
              targets={targets}
              selected={selected?.machineId}
              disabled={busy}
              onSelect={setPick}
              onSetup={
                model?.provisionFrom
                  ? (target) =>
                      router.push({
                        pathname: "/setup-project",
                        params: { source: model.provisionFrom!.machineId, projectId: model.provisionFrom!.projectId, target: target.machineId },
                      })
                  : undefined
              }
            />
          </View>
        )}
        <Field
          label={FORK_COPY.noteLabel}
          value={generated === null ? "" : note}
          onChangeText={setNote}
          placeholder={generated === null ? FORK_COPY.noteWriting : FORK_COPY.notePlaceholder}
          editable={generated !== null && !busy}
          multiline
          style={{ minHeight: 132, textAlignVertical: "top" }}
        />
        {noteError ? (
          <T variant="footnote" tone="negative">
            {noteError}
          </T>
        ) : null}
        <ErrorBanner error={error} />
        {Platform.OS !== "ios" && (
          <Button role="prominent" busy={busy} disabled={!ready} onPress={() => void send()}>
            {action}
          </Button>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
