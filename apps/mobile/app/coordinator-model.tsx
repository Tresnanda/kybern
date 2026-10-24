import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { COORDINATOR_ROLES, COORDINATOR_SETTINGS_COPY, cleanRoleDefault, withRoleOverride } from "../../../packages/kybern-client/src/coordinatorSettings";
import { findModel, modelChoices } from "../../../packages/kybern-client/src/models";
import { saveProjectCoordinator } from "../src/features/ProjectCoordinator";
import type { CoordinatorRole, ProviderKind, RoleDefault } from "../src/state/protocol";
import { errorText, useApp } from "../src/state/runtime";
import { ErrorBanner, IconButton, T } from "../src/ui/primitives";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import { SearchField } from "../src/ui/Search";
import { ProviderMark } from "../src/ui/ProviderMark";
import { space, useTheme } from "../src/ui/theme";

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

  const effortWord = (value: string | null | undefined) => (value ? value.charAt(0).toUpperCase() + value.slice(1) : "Default");
  return (
    <>
      <Stack.Screen
        options={{
          title: known ? `${known.label} model` : "Model",
          headerStyle: { backgroundColor: colors.grouped },
          headerRight: () => <IconButton name="xmark" label="Close" onPress={() => router.back()} />,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space["3xl"] }}
      >
        <ErrorBanner error={error} />
        {!project || !known ? (
          <T tone="secondary">This project or kind of work is no longer available. Close this and open the Project sheet again.</T>
        ) : (
          <>
            <InsetGroup>
              <ListRow
                title={COORDINATOR_SETTINGS_COPY.useDefault}
                subtitle="Follow the computer's Coordinator defaults for this kind of work."
                checked={!current}
                disabled={busy}
                onPress={() => void save(null)}
              />
            </InsetGroup>
            <SectionHeader title="Agent" inset />
            <InsetGroup>
              {available.map((item) => (
                <ListRow
                  key={item.kind}
                  title={item.display_name}
                  leading={<ProviderMark kind={item.kind} size={22} />}
                  checked={kind === item.kind}
                  disabled={busy}
                  onPress={() => {
                    setKind(item.kind);
                    setQuery("");
                  }}
                />
              ))}
              {sameAgent && efforts.length > 0 ? (
                <ListRow
                  title="Reasoning effort"
                  leading="sparkles"
                  value={effortWord(current?.effort)}
                  valueMenu={["", ...efforts].map((effort) => ({
                    title: effortWord(effort),
                    checked: (current?.effort ?? "") === effort,
                    onPress: () => void save({ ...current, effort: effort || null }, false),
                  }))}
                  disabled={busy}
                />
              ) : null}
            </InsetGroup>
            <SectionHeader title="Model" inset />
            <View style={{ gap: space.sm }}>
              <SearchField value={query} onChangeText={setQuery} placeholder="Search models" fill={colors.surface} />
              <InsetGroup>
                {models
                  .filter((model) => model.id)
                  .map((model) => (
                    <ListRow
                      key={model.id}
                      title={model.display_name}
                      subtitle={model.description ?? undefined}
                      checked={selected === model.id}
                      disabled={busy || !kind}
                      onPress={() => kind && void save({ provider: { kind, instance: instance(kind) }, model: model.id, effort: model.default_effort ?? null })}
                    />
                  ))}
              </InsetGroup>
              {customId && (
                <InsetGroup>
                  <ListRow
                    title={`Use “${customId}”`}
                    mono
                    subtitle="Custom model ID"
                    leading="plus"
                    disabled={busy || !kind}
                    onPress={() => kind && void save({ provider: { kind, instance: instance(kind) }, model: customId })}
                  />
                </InsetGroup>
              )}
            </View>
            <SectionFooter inset>Search, or type an exact model ID.</SectionFooter>
          </>
        )}
      </ScrollView>
    </>
  );
}
