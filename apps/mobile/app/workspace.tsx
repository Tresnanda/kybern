import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { confirm } from "../src/ui/Alert";
import { InsetGroup, ListRow, SectionHeader } from "../src/ui/List";
import { showToast } from "../src/ui/Toast";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { TaskRow } from "../src/features/Tasks";
import { Changes } from "../src/features/Changes";
import { Files } from "../src/features/Files";
import { Terminal } from "../src/features/Terminal";
import { Artifacts } from "../src/features/Artifacts";
import { ThreadNotes } from "../src/features/ThreadNotes";
import { type Checkpoint, type RuntimeTask } from "../src/state/protocol";
import {
  errorText,
  loadThread,
  refresh,
  rpc,
  useApp,
  useThread,
} from "../src/state/runtime";
import { Button, Empty, ErrorBanner, Field, Page } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, space, useTheme } from "../src/ui/theme";

export default function Workspace() {
  const {
    threadId,
    projectId,
    terminalId,
    login,
    tab: initialTab,
    reveal,
  } = useLocalSearchParams<{
    threadId?: string;
    projectId?: string;
    terminalId?: string;
    login?: string;
    tab?: string;
    /** A folder Files opens expanded (the outside-change row's repository). */
    reveal?: string;
  }>();
  const app = useApp();
  const snapshot = useThread(threadId ?? "");
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const thread = app.threads.find((t) => t.id === threadId) ?? snapshot.thread;
  const project = app.projects.find(
    (p) => p.id === (projectId ?? thread?.project_id),
  );
  const tab = initialTab ?? (threadId ? "More" : "Files");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const tasks = snapshot.tasks;
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [title, setTitle] = useState(thread?.title ?? "");
  useEffect(() => {
    if (!threadId || app.status !== "open") return;
    let alive = true;
    void Promise.all([rpc("threads.checkpoints", { thread_id: threadId })])
      .then(([c]) => {
        if (alive) {
          setCheckpoints(c.checkpoints);
        }
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [threadId, tab, app.status]);
  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError("");
    try {
      await work();
      if (done) showToast(done);
      await refresh();
      if (threadId) await loadThread(threadId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <Stack.Screen
        options={{
          title: tab === "More" ? "Thread details" : tab,
          headerStyle: { backgroundColor: tab === "Changes" || tab === "Artifacts" || tab === "More" ? colors.grouped : colors.background },
        }}
      />
      {tab === "Changes" && threadId ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={{ flex: 1, backgroundColor: colors.grouped }}
          contentContainerStyle={{ paddingTop: space.sm, paddingBottom: insets.bottom + space["2xl"], width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center" }}
          keyboardShouldPersistTaps="handled"
        >
          <Changes threadId={threadId} />
        </ScrollView>
      ) : tab === "Terminal" && threadId ? (
        <View style={{ flex: 1 }}>
          <Terminal key={`${app.activeId}:${threadId}:${terminalId ?? ""}`} threadId={threadId} initialTerminalId={terminalId} connectorLogin={login === "1"} />
        </View>
      ) : tab === "Files" && project ? (
        <Files key={project.id} project={project} threadId={threadId} reveal={reveal} />
      ) : (
        <Page grouped={tab === "Artifacts" || tab === "More"}>
          <ErrorBanner error={error} />
          {tab === "Artifacts" && thread && <Artifacts key={`${app.activeId}:${threadId}`} thread={thread} />}
          {tab === "Notes" && threadId && <ThreadNotes key={`${app.activeId}:${threadId}`} threadId={threadId} />}
          {tab === "More" && thread && (
            <>
              <SectionHeader title="Title" first />
              <View style={{ gap: space.md }}>
                <Field label="Thread title" hideLabel value={title} onChangeText={setTitle} placeholder="Name this thread" />
                <View style={{ alignSelf: "flex-start" }}>
                  <Button
                    size="medium"
                    busy={busy}
                    disabled={!title.trim() || title === thread.title}
                    onPress={() => void run(() => rpc("threads.update", { thread_id: thread.id, title: title.trim() }), "Thread renamed")}
                  >
                    Rename
                  </Button>
                </View>
              </View>
              <SectionHeader title="Conversation" />
              <InsetGroup>
                <ListRow
                  title={thread.pinned ? "Unpin thread" : "Pin thread"}
                  leading="pin"
                  onPress={() =>
                    void run(
                      () => rpc("threads.update", { thread_id: thread.id, pinned: !thread.pinned }),
                      thread.pinned ? "Thread unpinned" : "Thread pinned",
                    )
                  }
                />
                <ListRow
                  title="Agent, model and permissions"
                  leading="slider.horizontal.3"
                  chevron
                  onPress={() => router.push({ pathname: "/configure", params: { threadId: thread.id } })}
                />
                <ListRow
                  title="Hand off to another agent"
                  leading="arrow.triangle.swap"
                  chevron
                  onPress={() => router.push({ pathname: "/configure", params: { threadId: thread.id, handoff: "1" } })}
                />
                <ListRow
                  title="Skills, plugins and commands"
                  leading="sparkles"
                  chevron
                  onPress={() => router.push({ pathname: "/capabilities", params: { threadId: thread.id } })}
                />
                <ListRow
                  title="Compact conversation"
                  subtitle="The agent summarizes its context to make room"
                  leading="arrow.down.right.and.arrow.up.left"
                  onPress={() => void run(() => rpc("threads.compact", { thread_id: thread.id }), "Compacting the conversation")}
                />
                <ListRow
                  title="Release agent session"
                  subtitle="Frees resources; your next message resumes it"
                  leading="pause.circle"
                  onPress={() => void run(() => rpc("threads.release", { thread_id: thread.id }), "Session released")}
                />
                <ListRow
                  title="Archive thread"
                  leading="archivebox"
                  onPress={() =>
                    confirm({
                      title: "Archive this thread?",
                      message: "You can find it in the Archived filter in Threads.",
                      confirm: "Archive",
                      destructive: false,
                      onConfirm: () =>
                        void run(async () => {
                          await rpc("threads.archive", { thread_id: thread.id });
                          router.dismissTo("/library");
                        }, "Thread archived"),
                    })
                  }
                />
              </InsetGroup>
              <SectionHeader title="Agent limits" />
              <InsetGroup>
                {snapshot.providerUsage?.context && (
                  <ListRow
                    title="Context used"
                    subtitle={`${snapshot.providerUsage.context.used_tokens.toLocaleString()} of ${snapshot.providerUsage.context.window_tokens.toLocaleString()} tokens`}
                  />
                )}
                {snapshot.providerUsage?.limits?.map((limit) => (
                  <ListRow
                    key={limit.name}
                    title={limit.name}
                    subtitle={limit.resets_at ? `Resets ${new Date(limit.resets_at * 1000).toLocaleString()}` : undefined}
                    meta={`${Math.round(limit.used_percent)}% used`}
                  />
                ))}
                {!snapshot.providerUsage?.context && !snapshot.providerUsage?.limits?.length && (
                  <Empty variant="inline" title="This agent has not reported its limits." />
                )}
              </InsetGroup>
              <SectionHeader title="Agent activity" count={tasks.length || undefined} />
              <InsetGroup>
                {tasks.length ? (
                  tasks.map((task) => (
                    <View key={task.id} style={{ paddingHorizontal: space.lg }}>
                      <TaskRow task={task} />
                    </View>
                  ))
                ) : (
                  <Empty variant="inline" title="No background agents or processes." />
                )}
              </InsetGroup>
              <SectionHeader title="Checkpoints" count={checkpoints.length || undefined} />
              <InsetGroup>
                {checkpoints.length ? (
                  checkpoints.map((checkpoint, i) => (
                    <ListRow
                      key={checkpoint.turn_id}
                      title={`Checkpoint ${i + 1}`}
                      subtitle={new Date(checkpoint.created_at).toLocaleString()}
                      leading="clock.arrow.circlepath"
                      onPress={() =>
                        confirm({
                          title: `Restore checkpoint ${i + 1}?`,
                          message: "Workspace files and the conversation return to this point.",
                          confirm: "Restore",
                          onConfirm: () =>
                            void run(
                              () => rpc("threads.revert", { thread_id: thread.id, turn_id: checkpoint.turn_id }),
                              "Checkpoint restored",
                            ),
                        })
                      }
                    />
                  ))
                ) : (
                  <Empty variant="inline" title="Checkpoints appear after completed turns." />
                )}
              </InsetGroup>
            </>
          )}
        </Page>
      )}
    </KeyboardAvoidingView>
  );
}
