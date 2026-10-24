import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { COORDINATOR_ROLES, COORDINATOR_SETTINGS_COPY, cleanRoleDefault, withRoleOverride } from "../../../packages/kybern-client/src/coordinatorSettings";
import { findModel, modelChoices } from "../../../packages/kybern-client/src/models";
import { saveProjectCoordinator } from "../src/features/ProjectCoordinator";
import type { CoordinatorRole, ProviderKind, RoleDefault } from "../src/state/protocol";
import { errorText, useApp } from "../src/state/runtime";
import { ErrorBanner, Field, Group, Icon, IconButton, Page, T, Tap, styles } from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { useTheme } from "../src/ui/theme";

/** The model a project's Coordinator delegates one kind of work to: an agent, a model, an effort, or the default. */
export default function CoordinatorModelScreen() {
  const { projectId, role } = useLocalSearchParams<{ projectId?: string; role?: string }>();
  const app = useApp();
  const { colors } = useTheme();
  const project = app.projects.find((item) => item.id === projectId);
  const known = COORDINATOR_ROLES.find((item) => item.role === role);
  const current = known ? cleanRoleDefault(project?.coordinator?.role_defaults?.[known.role]) : null;
  const available = app.providers.filter((provider) => provider.available);
  const [kind, setKind] = useState<ProviderKind | undefined>(current?.provider?.kind ?? available[0]?.kind);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const provider = app.providers.find((item) => item.kind === kind);
  const sameAgent = current?.provider?.kind === kind;
  const { models, customId } = modelChoices(provider?.models ?? [], sameAgent ? current?.model : null, query);
  const selected = sameAgent && current?.model ? findModel(provider?.models ?? [], current.model)?.id ?? current.model : null;
  const efforts = (sameAgent && current?.model ? findModel(provider?.models ?? [], current.model)?.efforts : null) ?? [];

  const save = async (value: RoleDefault | null, close = true) => {
    if (!projectId || !known || busy) return;
    setBusy(true);
    setError("");
    try {
      await saveProjectCoordinator(projectId, withRoleOverride(project?.coordinator ?? null, known.role as CoordinatorRole, value));
      if (close) router.back();
    } catch (e) {
      setError(`${COORDINATOR_SETTINGS_COPY.saveFailed} ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const instance = (k: ProviderKind) => (app.providers.find((item) => item.kind === k)?.instances.includes("default") ? "default" : app.providers.find((item) => item.kind === k)?.instances[0] ?? "default");

  return (
    <>
      <Stack.Screen
        options={{
          title: known ? `${known.label} model` : "Model",
          headerRight: () => <IconButton name="xmark" label="Close" onPress={() => router.back()} />,
        }}
      />
      <Page>
        <ErrorBanner error={error} />
        {!project || !known ? (
          <T tone="secondary">This project or kind of work is no longer available. Close this and open the Project sheet again.</T>
        ) : (
          <>
            <Tap
              label={COORDINATOR_SETTINGS_COPY.useDefault}
              selected={!current}
              disabled={busy}
              onPress={() => void save(null)}
              style={[styles.spread, { padding: 16, marginBottom: 20, borderRadius: 18, backgroundColor: !current ? colors.accentSoft : colors.surface }]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <T variant="label">{COORDINATOR_SETTINGS_COPY.useDefault}</T>
                <T variant="footnote" tone="secondary">Follow the computer's Coordinator defaults for this kind of work.</T>
              </View>
              {!current && <Icon name="checkmark" size={14} />}
            </Tap>
            <Group title="Agent">
              <View style={{ borderRadius: 18, backgroundColor: colors.surface, overflow: "hidden" }}>
                {available.map((item, index) => (
                  <Tap
                    key={item.kind}
                    label={`Use ${item.display_name}`}
                    selected={kind === item.kind}
                    disabled={busy}
                    onPress={() => {
                      setKind(item.kind);
                      setQuery("");
                    }}
                    style={[styles.line, { paddingHorizontal: 16, minHeight: 52, borderTopWidth: index ? 0.5 : 0, borderColor: colors.line }]}
                  >
                    <ProviderMark kind={item.kind} size={20} />
                    <T style={{ flex: 1 }}>{item.display_name}</T>
                    {kind === item.kind && <Icon name="checkmark" size={14} />}
                  </Tap>
                ))}
              </View>
            </Group>
            {sameAgent && efforts.length > 0 && (
              <Group title="Reasoning effort">
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {["", ...efforts].map((effort) => {
                    const on = (current?.effort ?? "") === effort;
                    return (
                      <Tap
                        key={effort || "default"}
                        label={effort ? `${effort} effort` : "Default effort"}
                        selected={on}
                        disabled={busy}
                        onPress={() => void save({ ...current, effort: effort || null }, false)}
                        style={{ paddingHorizontal: 14, borderRadius: 22, alignItems: "center", backgroundColor: on ? colors.ink : colors.raised }}
                      >
                        <T variant="footnote" tone={on ? "inverse" : "ink"} style={{ textTransform: "capitalize" }}>{effort || "Default"}</T>
                      </Tap>
                    );
                  })}
                </View>
              </Group>
            )}
            <Group title="Model">
              <Field
                label="Find or enter a model"
                placeholder="Search models or enter an exact ID"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                returnKeyType="search"
              />
              <View style={{ borderRadius: 18, backgroundColor: colors.surface, overflow: "hidden" }}>
                {models
                  .filter((model) => model.id)
                  .map((model, index) => (
                    <Tap
                      key={model.id}
                      label={model.display_name}
                      selected={selected === model.id}
                      disabled={busy || !kind}
                      onPress={() => kind && void save({ provider: { kind, instance: instance(kind) }, model: model.id, effort: model.default_effort ?? null })}
                      style={[styles.spread, { paddingHorizontal: 16, paddingVertical: 12, minHeight: 52, borderTopWidth: index ? 0.5 : 0, borderColor: colors.line }]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <T variant="label">{model.display_name}</T>
                        {!!model.description && <T variant="footnote" tone="secondary" numberOfLines={2}>{model.description}</T>}
                      </View>
                      {selected === model.id && <Icon name="checkmark" size={12} />}
                    </Tap>
                  ))}
                {customId && (
                  <Tap
                    label={`Use ${customId}`}
                    disabled={busy || !kind}
                    onPress={() => kind && void save({ provider: { kind, instance: instance(kind) }, model: customId })}
                    style={[styles.spread, { padding: 16, minHeight: 52 }]}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <T variant="label">Use “{customId}”</T>
                      <T variant="footnote" tone="secondary">Custom model ID</T>
                    </View>
                    <Icon name="plus" size={16} />
                  </Tap>
                )}
              </View>
            </Group>
          </>
        )}
      </Page>
    </>
  );
}
