// New thread, as a form sheet. Project, agent, permissions, worktree, then the
// first message.

import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "@/connection/ConnectionContext";
import { PROVIDER_DISPLAY_NAME, type PermissionMode, type ProviderKind, type ProviderStatus } from "@/protocol";
import { useDaemon } from "@/state/daemon";
import { Button, IconButton } from "@/ui/Button";
import { Chips, type ChipOption } from "@/ui/Chips";
import { Glass } from "@/ui/Glass";
import { Screen, Txt } from "@/ui/Screen";
import { GUTTER, radius, space, type as t, useTheme } from "@/ui/theme";

const MODE_LABEL: Record<PermissionMode, string> = {
  supervised: "Supervised",
  "accept-edits": "Accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export default function NewThreadScreen() {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ project?: string }>();
  const { client } = useConnection();
  const { projects } = useDaemon();
  const [projectId, setProjectId] = useState<string | null>(params.project ?? projects[0]?.id ?? null);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [kind, setKind] = useState<ProviderKind | null>(null);
  const [mode, setMode] = useState<PermissionMode>("supervised");
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    if (!client) return;
    client
      .call("providers.list", {})
      .then((r) => {
        setProviders(r.providers);
        const first = r.providers.find((p) => p.available);
        if (first) {
          setKind(first.kind);
          if (!first.supported_permission_modes.includes("supervised")) setMode(first.supported_permission_modes[0] ?? "supervised");
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const selected = providers?.find((p) => p.kind === kind) ?? null;
  const modes = selected?.supported_permission_modes ?? [];
  const useWorktree = worktree ?? project?.worktrees_default ?? false;

  const projectOptions = useMemo<ChipOption<string>[]>(() => projects.map((p) => ({ value: p.id, label: p.name, icon: "folder" })), [projects]);
  const agentOptions = useMemo<ChipOption<ProviderKind>[]>(
    () => (providers ?? []).map((p) => ({ value: p.kind, label: PROVIDER_DISPLAY_NAME[p.kind] ?? p.display_name, disabled: !p.available })),
    [providers],
  );
  const modeOptions = useMemo<ChipOption<PermissionMode>[]>(
    () => modes.map((m) => ({ value: m, label: MODE_LABEL[m], icon: m === "full-access" ? "bolt" : undefined, accent: m === "full-access" ? th.fullAccess : undefined })),
    [modes, th.fullAccess],
  );

  const canStart = Boolean(client && projectId && kind && selected?.available && text.trim());

  const create = async () => {
    if (!client || !projectId || !kind) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await client.call("threads.create", {
        project_id: projectId,
        provider: { kind, instance: "default" },
        permission_mode: mode,
        use_worktree: useWorktree,
        message: { parts: [{ type: "text", text: text.trim() }] },
      });
      router.dismiss();
      router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={styles.header}>
        <Txt variant="title2">New thread</Txt>
        <IconButton icon="close" size={34} accessibilityLabel="Close" onPress={() => router.dismiss()} haptic={false} />
      </View>
      <KeyboardAwareScrollView bottomOffset={24} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]} keyboardShouldPersistTaps="handled">
        <Group label="Project">
          {projectOptions.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hscroll} style={styles.hscrollOuter}>
              <Chips options={projectOptions} value={projectId} onChange={(v) => { setProjectId(v); setWorktree(null); }} />
            </ScrollView>
          ) : (
            <Txt variant="subhead" tone="secondary">
              No projects on this machine yet. Add one from the desktop app or the CLI.
            </Txt>
          )}
        </Group>

        <Group label="Agent">
          {providers ? <Chips options={agentOptions} value={kind} onChange={(k) => { setKind(k); const p = providers.find((x) => x.kind === k); if (p && !p.supported_permission_modes.includes(mode)) setMode(p.supported_permission_modes[0] ?? "supervised"); }} /> : <Txt variant="subhead" tone="tertiary">Loading agents…</Txt>}
          {selected && !selected.available ? (
            <Txt variant="footnote" color={th.failed}>
              {selected.unavailable_reason ?? "Not installed on the daemon host."}
            </Txt>
          ) : null}
          {providers && !providers.some((p) => p.available) ? (
            <Txt variant="footnote" color={th.failed}>
              No agent is installed on the daemon host. Install one, then restart kybernd.
            </Txt>
          ) : null}
        </Group>

        {modes.length > 0 ? (
          <Group label="Permissions">
            <Chips options={modeOptions} value={mode} onChange={setMode} />
            <Txt variant="footnote" tone="tertiary">
              {mode === "full-access" ? "Runs commands and edits files without asking." : mode === "supervised" ? "Asks before every command and edit." : mode === "accept-edits" ? "Edits files freely, asks before commands." : "Decides on its own within the project."}
            </Txt>
          </Group>
        ) : null}

        {project?.is_git ? (
          <Glass radius={radius.lg}>
            <View style={styles.toggleRow}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="body">Work in a separate worktree</Txt>
                <Txt variant="footnote" tone="secondary">
                  Keeps the agent's branch away from your checkout.
                </Txt>
              </View>
              <Switch value={useWorktree} onValueChange={setWorktree} trackColor={{ true: th.ink }} thumbColor={undefined} ios_backgroundColor={th.surfaceRaised} />
            </View>
          </Glass>
        ) : null}

        <Group label="First message">
          <Glass radius={radius.lg}>
            <TextInput
              accessibilityLabel="First message"
              style={[styles.message, t.body, { color: th.text }]}
              placeholder="What should the agent do?"
              placeholderTextColor={th.textTertiary}
              value={text}
              onChangeText={setText}
              multiline
              autoFocus
              keyboardAppearance={th.dark ? "dark" : "light"}
            />
          </Glass>
        </Group>

        {error ? (
          <Txt variant="footnote" color={th.failed}>
            {error}
          </Txt>
        ) : null}

        <Button title="Start thread" variant="ink" size="large" icon="send" haptic="medium" disabled={!canStart} busy={busy} onPress={() => void create()} />
      </KeyboardAwareScrollView>
    </Screen>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Txt variant="footnote" tone="secondary" style={styles.groupLabel}>
        {label}
      </Txt>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: GUTTER, paddingTop: space.xl, paddingBottom: space.md },
  content: { paddingHorizontal: GUTTER, gap: space.xl },
  group: { gap: space.sm },
  groupLabel: { textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12, paddingHorizontal: 4 },
  hscrollOuter: { marginHorizontal: -GUTTER },
  hscroll: { paddingHorizontal: GUTTER },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: space.lg, paddingHorizontal: space.lg, paddingVertical: space.md },
  message: { minHeight: 120, paddingHorizontal: space.lg, paddingVertical: space.md, textAlignVertical: "top" },
});
