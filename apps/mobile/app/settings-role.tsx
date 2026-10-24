// The computer's default model for one kind of Coordinator work: an agent, a
// model and an effort, or the Coordinator's own (Settings › Delegation).
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import {
  COORDINATOR_ROLES,
  COORDINATOR_SETTINGS_COPY as COPY,
  cleanRoleDefault,
  withGlobalRoleDefault,
} from "../../../packages/kybern-client/src/coordinatorSettings";
import { findModel, modelChoices } from "../../../packages/kybern-client/src/models";
import type { ProviderKind, RoleDefault } from "../src/state/protocol";
import { useApp } from "../src/state/runtime";
import { saveSettings, useSettings } from "../src/state/settings";
import { Section } from "../src/features/settings/common";
import { ListRow } from "../src/ui/List";
import { Empty, ErrorBanner, Page } from "../src/ui/primitives";
import { ProviderMark } from "../src/ui/ProviderMark";
import { SearchField } from "../src/ui/Search";
import { View } from "react-native";
import { space } from "../src/ui/theme";

export default function SettingsRoleScreen() {
  const { role } = useLocalSearchParams<{ role?: string }>();
  const app = useApp();
  const { settings, error } = useSettings();
  const known = COORDINATOR_ROLES.find((item) => item.role === role);
  const current = known && settings ? cleanRoleDefault(settings.orchestration.role_defaults?.[known.role]) : null;
  const available = app.providers.filter((provider) => provider.available);
  const [kind, setKind] = useState<ProviderKind | undefined>(current?.provider?.kind);
  const [query, setQuery] = useState("");
  const provider = app.providers.find((item) => item.kind === kind);
  const sameAgent = !!kind && current?.provider?.kind === kind;
  const { models, customId } = modelChoices(provider?.models ?? [], sameAgent ? current?.model : null, query);
  const selectedModel = sameAgent ? (current?.model ? findModel(provider?.models ?? [], current.model)?.id ?? current.model : "") : null;
  const efforts = (sameAgent && current?.model ? findModel(provider?.models ?? [], current.model)?.efforts : provider?.supported_efforts) ?? [];
  const instance = (k: ProviderKind) => {
    const instances = app.providers.find((item) => item.kind === k)?.instances ?? [];
    return instances.includes("default") ? "default" : instances[0] ?? "default";
  };
  const save = (value: RoleDefault | null) => {
    if (!settings || !known) return;
    void saveSettings({ ...settings, orchestration: withGlobalRoleDefault(settings.orchestration, known.role, value) });
  };
  return (
    <Page grouped>
      <Stack.Screen options={{ title: known ? `${known.label} model` : "Model" }} />
      <ErrorBanner error={error} />
      {!known || !settings ? (
        <Empty title="Not available" detail="Close this and open Settings › Delegation again." />
      ) : (
        <>
          <Section first footer="Children use the Coordinator's own agent and model.">
            <ListRow
              title={COPY.sameAsCoordinator}
              checked={!current}
              onPress={() => {
                save(null);
                router.back();
              }}
            />
          </Section>
          <Section title="Agent">
            {available.map((item) => (
              <ListRow
                key={item.kind}
                title={item.display_name}
                leading={<ProviderMark kind={item.kind} size={20} />}
                checked={current?.provider?.kind === item.kind}
                onPress={() => {
                  setKind(item.kind);
                  setQuery("");
                  if (current?.provider?.kind !== item.kind) save({ provider: { kind: item.kind, instance: instance(item.kind) } });
                }}
              />
            ))}
          </Section>
          {provider ? (
            <>
              <View style={{ marginTop: space["2xl"] }}>
                <SearchField value={query} onChangeText={setQuery} placeholder={`Search ${provider.display_name} models`} />
              </View>
              <Section title="Model">
                {models.slice(0, 40).map((model) => (
                  <ListRow
                    key={model.id || "default"}
                    title={model.display_name}
                    subtitle={"description" in model && model.description ? model.description : undefined}
                    checked={selectedModel === model.id}
                    onPress={() => save({ provider: { kind: provider.kind, instance: instance(provider.kind) }, model: model.id || null })}
                  />
                ))}
                {customId ? (
                  <ListRow
                    title={`Use “${customId}”`}
                    subtitle="Custom model ID"
                    leading="plus"
                    onPress={() => save({ provider: { kind: provider.kind, instance: instance(provider.kind) }, model: customId })}
                  />
                ) : null}
              </Section>
              {sameAgent && efforts.length ? (
                <Section title="Effort">
                  {["", ...efforts].map((effort) => (
                    <ListRow
                      key={effort || "default"}
                      title={effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : "Default effort"}
                      checked={(current?.effort ?? "") === effort}
                      onPress={() => save({ ...current, effort: effort || null })}
                    />
                  ))}
                </Section>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Page>
  );
}
