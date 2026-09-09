import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Alert } from "../src/ui/Alert";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { TaskRow } from "../src/features/Tasks";
import { Changes } from "../src/features/Changes";
import { Files } from "../src/features/Files";
import { Terminal } from "../src/features/Terminal";
import { type Checkpoint, type RuntimeTask } from "../src/state/protocol";
import {
  errorText,
  loadThread,
  refresh,
  rpc,
  useApp,
  useThread,
} from "../src/state/runtime";
import {
  Button,
  ErrorBanner,
  Field,
  Group,
  Page,
  Row,
  T,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function Workspace() {
  const {
    threadId,
    projectId,
    tab: initialTab,
  } = useLocalSearchParams<{
    threadId?: string;
    projectId?: string;
    tab?: string;
  }>();
  const app = useApp();
  const snapshot = useThread(threadId ?? "");
  const { colors } = useTheme();
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
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await work();
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
          title:
            tab === "More"
              ? "Thread details"
              : tab === "Changes"
                ? "Diffs"
                : tab,
        }}
      />
      <View
        style={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: 16,
          gap: 14,
        }}
      >
        <T variant="caption" tone="secondary">
          {project?.name ?? "Workspace"}
          {thread?.worktree ? ` / ${thread.worktree.branch}` : ""}
        </T>
      </View>
      {tab === "Terminal" && threadId ? (
        <View style={{ flex: 1 }}>
          <Terminal threadId={threadId} />
        </View>
      ) : tab === "Files" && project ? (
        <Files key={project.id} project={project} threadId={threadId} />
      ) : (
        <Page>
          <ErrorBanner error={error} />
          {tab === "Changes" && threadId && <Changes threadId={threadId} />}
          {tab === "More" && thread && (
            <>
              <Group title="Conversation">
                <Field
                  label="Thread title"
                  value={title}
                  onChangeText={setTitle}
                />
                <View style={{ marginTop: 12 }}>
                  <Button
                    secondary
                    busy={busy}
                    disabled={!title.trim() || title === thread.title}
                    onPress={() =>
                      void run(() =>
                        rpc("threads.update", {
                          thread_id: thread.id,
                          title: title.trim(),
                        }),
                      )
                    }
                  >
                    Rename thread
                  </Button>
                </View>
                <Row
                  title={thread.pinned ? "Unpin thread" : "Pin thread"}
                  icon="pin"
                  onPress={() =>
                    void run(() =>
                      rpc("threads.update", {
                        thread_id: thread.id,
                        pinned: !thread.pinned,
                      }),
                    )
                  }
                />
                <Row
                  title="Agent, model, and permissions"
                  icon="slider.horizontal.3"
                  onPress={() =>
                    router.push({
                      pathname: "/configure",
                      params: { threadId: thread.id },
                    })
                  }
                />
                <Row
                  title="Hand off to another agent"
                  icon="arrow.triangle.swap"
                  onPress={() =>
                    router.push({
                      pathname: "/configure",
                      params: { threadId: thread.id, handoff: "1" },
                    })
                  }
                />
                <Row
                  title="Compact conversation"
                  detail="Let the agent summarize context to make room."
                  icon="arrow.down.right.and.arrow.up.left"
                  onPress={() =>
                    void run(() =>
                      rpc("threads.compact", { thread_id: thread.id }),
                    )
                  }
                />
                <Row
                  title="Release agent session"
                  detail="Free resources. Your next message resumes the session."
                  icon="pause.circle"
                  onPress={() =>
                    void run(() =>
                      rpc("threads.release", { thread_id: thread.id }),
                    )
                  }
                />
                <Row
                  title="Archive thread"
                  icon="archivebox"
                  onPress={() =>
                    Alert.alert(
                      "Archive this thread?",
                      "You can find it in the Archived filter in Threads.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Archive thread",
                          onPress: () =>
                            void run(async () => {
                              await rpc("threads.archive", {
                                thread_id: thread.id,
                              });
                              router.dismissTo("/library");
                            }),
                        },
                      ],
                    )
                  }
                />
              </Group>
              <Group title="Agent activity">
                {tasks.length ? (
                  tasks.map((task) => <TaskRow key={task.id} task={task} />)
                ) : (
                  <T variant="caption" tone="secondary">
                    No background agents or processes.
                  </T>
                )}
              </Group>
              <Group title="Agent limits">
                {snapshot.providerUsage?.context && (
                  <Row
                    title="Context used"
                    detail={`${snapshot.providerUsage.context.used_tokens.toLocaleString()} of ${snapshot.providerUsage.context.window_tokens.toLocaleString()} tokens`}
                  />
                )}
                {snapshot.providerUsage?.limits?.map((limit) => (
                  <Row
                    key={limit.name}
                    title={limit.name}
                    detail={
                      limit.resets_at
                        ? `Resets ${new Date(limit.resets_at * 1000).toLocaleString()}`
                        : undefined
                    }
                    trailing={
                      <T variant="caption">
                        {Math.round(limit.used_percent)}% used
                      </T>
                    }
                  />
                ))}
                {!snapshot.providerUsage?.context &&
                  !snapshot.providerUsage?.limits?.length && (
                    <T variant="caption" tone="secondary">
                      This agent has not reported its limits.
                    </T>
                  )}
              </Group>
              <Row
                title="Skills, plugins, and commands"
                icon="sparkles"
                onPress={() =>
                  router.push({
                    pathname: "/capabilities",
                    params: { threadId: thread.id },
                  })
                }
              />
              <Group title="Checkpoints">
                {checkpoints.map((checkpoint, i) => (
                  <Row
                    key={checkpoint.turn_id}
                    title={`Checkpoint ${i + 1}`}
                    detail={new Date(checkpoint.created_at).toLocaleString()}
                    icon="clock.arrow.circlepath"
                    onPress={() =>
                      Alert.alert(
                        "Restore this checkpoint?",
                        "Workspace files and the conversation will return to this point.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Restore checkpoint",
                            style: "destructive",
                            onPress: () =>
                              void run(() =>
                                rpc("threads.revert", {
                                  thread_id: thread.id,
                                  turn_id: checkpoint.turn_id,
                                }),
                              ),
                          },
                        ],
                      )
                    }
                  />
                ))}
                {!checkpoints.length && (
                  <T variant="caption" tone="secondary">
                    Checkpoints appear after completed turns.
                  </T>
                )}
              </Group>
            </>
          )}
        </Page>
      )}
    </KeyboardAvoidingView>
  );
}
