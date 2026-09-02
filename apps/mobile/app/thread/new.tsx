import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnection } from "@/connection/ConnectionContext";
import { PROVIDER_DISPLAY_NAME, type PermissionMode, type ProviderKind, type ProviderStatus } from "@/protocol";
import { Composer } from "@/ui/Composer";
import { Caption, EmptyState, Screen } from "@/ui/Screen";
import { radius, space, type as t, useTheme } from "@/ui/theme";

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
  const { project } = useLocalSearchParams<{ project: string }>();
  const { client } = useConnection();
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [kind, setKind] = useState<ProviderKind | null>(null);
  const [mode, setMode] = useState<PermissionMode>("supervised");
  const [error, setError] = useState<string | null>(null);

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

  const selected = providers?.find((p) => p.kind === kind) ?? null;
  const modes = selected?.supported_permission_modes ?? [];

  const create = async (text: string) => {
    if (!client || !project || !kind) return;
    setError(null);
    try {
      const thread = await client.call("threads.create", {
        project_id: project,
        provider: { kind, instance: "default" },
        permission_mode: mode,
        message: { parts: [{ type: "text", text }] },
      });
      router.replace({ pathname: "/thread/[id]", params: { id: thread.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };

  if (!client || !project) {
    return (
      <Screen>
        <EmptyState title="Nothing to create" hint="Open a project from the threads list first." />
      </Screen>
    );
  }

  return (
    <Screen>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top + 44}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.group}>
            <Caption>Agent</Caption>
            <View style={styles.chips}>
              {(providers ?? []).map((p) => (
                <Chip
                  key={p.kind}
                  label={PROVIDER_DISPLAY_NAME[p.kind] ?? p.display_name}
                  selected={p.kind === kind}
                  disabled={!p.available}
                  onPress={() => {
                    setKind(p.kind);
                    if (!p.supported_permission_modes.includes(mode)) setMode(p.supported_permission_modes[0] ?? "supervised");
                  }}
                />
              ))}
            </View>
            {selected && !selected.available ? (
              <Caption color={th.failed}>{selected.unavailable_reason ?? "Not available on the daemon host"}</Caption>
            ) : null}
            {providers && !providers.some((p) => p.available) ? (
              <Caption color={th.failed}>No agent is installed on the daemon host. Install one, then restart kybernd.</Caption>
            ) : null}
          </View>

          {modes.length > 0 ? (
            <View style={styles.group}>
              <Caption>Permissions</Caption>
              <View style={styles.chips}>
                {modes.map((m) => (
                  <Chip key={m} label={MODE_LABEL[m]} selected={m === mode} onPress={() => setMode(m)} />
                ))}
              </View>
            </View>
          ) : null}

          {error ? <Text style={[t.body, { color: th.failed }]}>{error}</Text> : null}
        </ScrollView>
        <View style={{ paddingBottom: insets.bottom }}>
          <Composer placeholder="What should the agent do?" autoFocus disabled={!kind || !selected?.available} onSend={create} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function Chip({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? th.accent : th.surface,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
      ]}
    >
      <Text style={[t.body, { color: selected ? th.onAccent : th.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: space.lg, gap: space.xl },
  group: { gap: space.sm },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md },
});
