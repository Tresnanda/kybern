import { threadHasActivity } from "../src/state/runtime";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Composer } from "../src/features/Composer";
import { setDraft, useDraft } from "../src/state/draft";
import { type UserMessage } from "../src/state/protocol";
import { refresh, rpc, useApp } from "../src/state/runtime";
import { Brand } from "../src/ui/Brand";
import { Button, Icon, IconButton, T, Tap, styles } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function Home() {
  const app = useApp();
  const draft = useDraft();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [prompt, setPrompt] = useState("");
  const connected = app.status === "open";
  const project =
    app.projects.find((p) => p.id === draft.projectId) ?? app.projects[0];
  const recent = app.threads
    .filter((t) => t.status !== "archived")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 2);
  const active = app.threads.filter((t) =>
    threadHasActivity(t, app.activity),
  ).length;
  useEffect(() => {
    if (project && project.id !== draft.projectId)
      setDraft({ projectId: project.id });
    if (
      app.providers.length &&
      !app.providers.some((p) => p.kind === draft.provider && p.available)
    ) {
      const first = app.providers.find((p) => p.available);
      if (first)
        setDraft({
          provider: first.kind,
          instance: first.instances[0] ?? "default",
          model: "",
          effort: "",
        });
    }
  }, [project?.id, app.providers, draft.projectId, draft.provider]);
  async function send(message: UserMessage) {
    if (!project) throw new Error("Add a project before starting a thread.");
    const thread = await rpc("threads.create", {
      project_id: project.id,
      provider: { kind: draft.provider, instance: draft.instance },
      permission_mode: draft.permission,
      use_worktree: draft.worktree && project.is_git,
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(draft.baseBranch ? { base_branch: draft.baseBranch } : {}),
      message,
    });
    void refresh();
    router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 18,
          paddingBottom: 8,
          ...styles.spread,
        }}
      >
        <IconButton
          name="sidebar.left"
          label="Open threads"
          onPress={() => router.push("/library")}
        />
        <View style={[styles.line, { gap: 9 }]}>
          <Brand size={21} />
          <T variant="heading" style={{ fontSize: 19 }}>
            kybern
          </T>
        </View>
        <IconButton
          name="gearshape"
          label="Open settings"
          onPress={() => router.push("/settings")}
        />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 28,
          paddingTop: 24,
          paddingBottom: 20,
          width: "100%",
          maxWidth: 760,
          alignSelf: "center",
        }}
      >
        <Animated.View
          entering={FadeIn.duration(280).reduceMotion(ReduceMotion.System)}
          style={{ flex: 1, justifyContent: "center", paddingBottom: 16 }}
        >
          <View style={{ marginBottom: 24 }}>
            <Brand size={52} />
          </View>
          <T variant="display">What are we{`\n`}building?</T>
          <T tone="secondary" style={{ marginTop: 18, maxWidth: 300 }}>
            {connected
              ? "Choose a project and start a conversation."
              : "Work with your coding agents from anywhere."}
          </T>
          {!connected ? (
            <View style={{ marginTop: 30, alignSelf: "flex-start" }}>
              <Button
                onPress={() =>
                  app.activeId
                    ? router.push("/settings")
                    : router.push("/connect")
                }
                icon="arrow.right"
              >
                {app.activeId ? "Open connections" : "Connect your computer"}
              </Button>
            </View>
          ) : (
            <View style={{ marginTop: 28, alignItems: "flex-start", gap: 2 }}>
              {(
                [
                  {
                    icon: "hammer",
                    title: "Build something new",
                    prompt: "Help me build ",
                  },
                  {
                    icon: "viewfinder",
                    title: "Explore this project",
                    prompt:
                      "Explore this project and explain how it is organized.",
                  },
                  {
                    icon: "arrow.triangle.branch",
                    title: "Review recent changes",
                    prompt:
                      "Review the recent changes in this project. Look for bugs and improvements.",
                  },
                ] as const
              ).map((item) => (
                <Tap
                  key={item.title}
                  label={item.title}
                  onPress={() => setPrompt(item.prompt)}
                  style={[styles.line, { paddingVertical: 4, gap: 13 }]}
                >
                  <Icon name={item.icon} size={18} color={colors.secondary} />
                  <T variant="label" tone="secondary">
                    {item.title}
                  </T>
                  <Icon name="arrow.up.left" size={11} color={colors.muted} />
                </Tap>
              ))}
            </View>
          )}
        </Animated.View>
        {connected && recent.length > 0 && (
          <View style={{ paddingTop: 8, gap: 4 }}>
            <View style={styles.spread}>
              <T variant="caption" tone="muted">
                Pick up a thread
              </T>
              <Tap
                label="View all threads"
                onPress={() => router.push("/library")}
              >
                <T variant="caption" tone="secondary">
                  View all
                </T>
              </Tap>
            </View>
            {recent.map((t) => (
              <Tap
                key={t.id}
                label={t.title || "Untitled thread"}
                onPress={() =>
                  router.push({
                    pathname: "/thread/[id]",
                    params: { id: t.id },
                  })
                }
                style={[styles.spread, { paddingVertical: 4 }]}
              >
                <T variant="label" numberOfLines={1} style={{ flex: 1 }}>
                  {t.title || "Untitled thread"}
                </T>
                <Icon
                  name={
                    threadHasActivity(t, app.activity)
                      ? "circle.dotted"
                      : "arrow.up.right"
                  }
                  size={14}
                  color={colors.secondary}
                />
              </Tap>
            ))}
          </View>
        )}
      </ScrollView>
      <View style={{ paddingHorizontal: 28, ...styles.spread }}>
        <Tap
          label={project ? `Change project, ${project.name}` : "Add a project"}
          onPress={() =>
            router.push(connected ? "/project-picker" : "/connect")
          }
          style={[styles.line, { gap: 7 }]}
        >
          <Icon name="folder" size={15} color={colors.secondary} />
          <T variant="caption" tone="secondary">
            {project?.name ??
              (connected ? "Choose a project" : "No computer connected")}
          </T>
          {project && (
            <Icon name="chevron.down" size={9} color={colors.muted} />
          )}
        </Tap>
        {(active > 0 || app.approvals.length > 0) && (
          <Tap
            label="View agent activity"
            onPress={() => router.push("/activity")}
          >
            <T variant="caption" tone="accent">
              {app.approvals.length
                ? `${app.approvals.length} needs you`
                : `${active} working`}
            </T>
          </Tap>
        )}
      </View>
      <Composer
        onSend={send}
        disabled={!connected || !project}
        prompt={prompt}
        onPromptConsumed={() => setPrompt("")}
      />
      <View style={{ height: Math.max(insets.bottom, 12) }} />
    </KeyboardAvoidingView>
  );
}
