import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  createProjectCoordinatorStarter,
  projectCoordinatorMode,
} from "../../../packages/kybern-client/src/projectCoordinator";
import { Composer } from "../src/features/Composer";
import { setDraft, useDraft } from "../src/state/draft";
import type { UserMessage } from "../src/state/protocol";
import {
  activeEnvironment,
  activeConnectionEpoch,
  ensureThread,
  refresh,
  rpc,
  useApp,
} from "../src/state/runtime";
import { useSendTransition } from "../src/components/liquid/SendTransition";
import { DRAFT_SEND_THREAD } from "../src/state/sendTransition";
import { Brand } from "../src/ui/Brand";
import { Empty, Page, T } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function CoordinatorSetup() {
  const { projectId = "" } = useLocalSearchParams<{ projectId: string }>();
  const app = useApp();
  const draft = useDraft();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const sendMotion = useSendTransition();
  const [destination, setDestination] = useState<string | null>(null);
  const project = app.projects.find((item) => item.id === projectId);
  const provider = app.providers.find((item) => item.kind === draft.provider && item.available);
  const environmentId = useRef(activeEnvironment()?.id);
  const connectionEpoch = useRef(activeConnectionEpoch());
  function checkConnection() {
    if (activeEnvironment()?.id !== environmentId.current || activeConnectionEpoch() !== connectionEpoch.current)
      throw new Error("The connected computer changed. Open the coordinator from that project again.");
  }
  const starterRef = useRef<ReturnType<typeof createProjectCoordinatorStarter> | null>(null);
  const starter = starterRef.current ?? (starterRef.current = createProjectCoordinatorStarter(
    async (method, params) => {
      checkConnection();
      const result = await rpc(method, params);
      checkConnection();
      return result;
    }, randomUUID,
  ));

  useEffect(() => {
    if (projectId && draft.projectId !== projectId) setDraft({ projectId });
    if (!provider) {
      const first = app.providers.find((item) => item.available);
      if (first) setDraft({ provider: first.kind, instance: first.instances[0] ?? "default", model: "", effort: "" });
    }
  }, [projectId, draft.projectId, provider, app.providers]);

  const outgoing = sendMotion.outgoing?.sourceThreadId === DRAFT_SEND_THREAD ? sendMotion.outgoing : null;
  useEffect(() => {
    if (destination && outgoing?.receipt?.threadId === destination && sendMotion.flight?.id !== outgoing.id)
      router.dismissTo({ pathname: "/thread/[id]", params: { id: destination, created: "1" } });
  }, [destination, outgoing?.receipt?.threadId, outgoing?.id, sendMotion.flight?.id]);

  async function send(message: UserMessage) {
    if (!project || !provider) throw new Error("Choose an available harness before starting the coordinator.");
    const result = await starter.send({
      projectId: project.id,
      provider,
      instance: draft.instance,
      model: draft.model || undefined,
      effort: draft.effort || undefined,
      permissionMode: draft.permission,
    }, message);
    checkConnection();
    // Creation and send are acknowledged; hydration must not turn them into a retry.
    void refresh();
    await ensureThread(result.thread.id).catch(() => {});
    setDestination(result.thread.id);
    return { threadId: result.thread.id };
  }

  if (!project) return <Page><Empty icon="folder" title="Project unavailable" detail="Return to Projects and choose an available project." /></Page>;

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 28, maxWidth: 760, alignSelf: "center", width: "100%" }}>
        <View style={{ alignItems: "center", gap: 18, paddingVertical: 24 }}>
          <Brand size={36} />
          <T variant="caption" tone="secondary">Project coordinator</T>
          <T variant="title" style={{ textAlign: "center" }}>{`What should we work on in ${project.name}?`}</T>
          <T tone="secondary" style={{ textAlign: "center", maxWidth: 480 }}>
            Describe the goal. Your coordinator plans the work, delegates tasks, and keeps project knowledge for next time.
          </T>
        </View>
      </ScrollView>
      <View style={{ paddingHorizontal: 28, paddingBottom: 12, maxWidth: 760, alignSelf: "center", width: "100%" }}>
        <T variant="caption" tone="secondary">
          {projectCoordinatorMode(draft.provider) === "dedicated"
            ? "Implementation runs in worker conversations. You can change the coordinator’s harness later."
            : "This harness follows the coordinator role while retaining its native coding tools. You can change harnesses later."}
        </T>
      </View>
      <Composer onSend={send} disabled={app.status !== "open" || !provider || !!destination} />
      <View style={{ height: Math.max(12, insets.bottom) }} />
    </KeyboardAvoidingView>
  );
}
