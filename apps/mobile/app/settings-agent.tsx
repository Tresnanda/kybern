// One agent's configuration on the computer: version and update, executable,
// default model and environment variables.
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useHarnessUpdates } from "../src/features/settings/Agents";
import { Section } from "../src/features/settings/common";
import { accountStatusLabel, harnessUpdateLabel } from "../src/features/settings/labels";
import { PROVIDER_DISPLAY_NAME, type ProviderKind, type ProviderSettings } from "../src/state/protocol";
import { errorText, rpc, useApp } from "../src/state/runtime";
import { loadAccounts, useAccounts } from "../src/state/accounts";
import { saveSettings, useSettings } from "../src/state/settings";
import { ListRow, SectionFooter } from "../src/ui/List";
import { Button, ErrorBanner, Field, Page } from "../src/ui/primitives";
import { showToast } from "../src/ui/Toast";
import { space } from "../src/ui/theme";

export default function SettingsAgentScreen() {
  const { kind } = useLocalSearchParams<{ kind: ProviderKind }>();
  const app = useApp();
  const { settings } = useSettings();
  const provider = app.providers.find((p) => p.kind === kind);
  const { updates, setUpdates, error: updatesError } = useHarnessUpdates();
  const update = updates.find((u) => u.kind === kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = provider?.display_name ?? PROVIDER_DISPLAY_NAME[kind] ?? "Agent";
  // Antigravity has one account per computer, signed in there. The phone shows its state.
  const { accounts } = useAccounts();
  useEffect(() => {
    if (kind === "antigravity") void loadAccounts();
  }, [kind]);
  const account = kind === "antigravity" ? accounts.find((a) => a.provider.kind === kind) : undefined;
  const custom = !!settings?.providers[kind]?.binary;
  const runUpdate = () => {
    setBusy(true);
    setError("");
    rpc("harness_updates.run", { kind })
      .then((value) => {
        setUpdates((list) => [...list.filter((u) => u.kind !== value.kind), value]);
        showToast(value.message || `Updating ${name}`);
      })
      .catch((e) => setError(`Unable to start the update. ${errorText(e)}`))
      .finally(() => setBusy(false));
  };
  return (
    <Page grouped>
      <Stack.Screen options={{ title: name }} />
      <ErrorBanner error={error || updatesError} />
      <Section first footer={provider?.available ? update?.message || null : provider?.unavailable_reason ?? "Install this agent on your computer to use it."}>
        <ListRow title="Version" value={provider?.version ?? (provider?.available ? "Installed" : "Not installed")} />
        {provider?.binary_path ? <ListRow title="Location" subtitle={provider.binary_path} subtitleLines={2} /> : null}
        {update ? <ListRow title="Updates" value={harnessUpdateLabel(update.status)} /> : null}
      </Section>
      {kind === "antigravity" && provider?.available ? (
        <Section footer="Sign in on your computer, in Settings › Agent providers.">
          <ListRow
            title="Account"
            subtitle={account?.identity?.email}
            value={account ? accountStatusLabel(account.status) : "Status unknown"}
          />
        </Section>
      ) : null}
      {provider?.available && kind !== "cursor" && !custom ? (
        <View style={{ marginTop: space.lg }}>
          <Button icon="arrow.clockwise" busy={busy || update?.status === "updating"} onPress={runUpdate}>
            Update now
          </Button>
        </View>
      ) : null}
      {settings ? (
        <Configuration
          key={`${app.activeId}:${kind}`}
          value={settings.providers[kind]}
          onSave={(value) =>
            saveSettings({ ...settings, providers: { ...settings.providers, [kind]: value } })
          }
        />
      ) : null}
    </Page>
  );
}

function Configuration({
  value,
  onSave,
}: {
  value: ProviderSettings | undefined;
  onSave: (value: ProviderSettings) => Promise<boolean>;
}) {
  const [binary, setBinary] = useState(value?.binary ?? "");
  const [model, setModel] = useState(value?.model ?? "");
  const [environment, setEnvironment] = useState(JSON.stringify(value?.env ?? {}, null, 2));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    let env: unknown;
    try {
      env = JSON.parse(environment);
    } catch {
      env = null;
    }
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
      setError("Use a JSON object with a string value for each environment variable.");
      return;
    }
    setError("");
    setBusy(true);
    const saved = await onSave({
      ...value,
      binary: binary.trim() || null,
      model: model.trim() || null,
      env: env as Record<string, string>,
    });
    setBusy(false);
    if (saved) showToast("Agent configuration saved");
  };
  return (
    <View style={{ marginTop: space["2xl"], gap: space.lg }}>
      <Field label="Executable path" placeholder="Use the installed agent" autoCapitalize="none" autoCorrect={false} value={binary} onChangeText={setBinary} />
      <Field label="Default model" placeholder="Use the agent default" autoCapitalize="none" autoCorrect={false} value={model} onChangeText={setModel} />
      <View>
        <Field
          label="Environment variables"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          value={environment}
          onChangeText={setEnvironment}
          style={{ minHeight: 120, textAlignVertical: "top" }}
          error={error || undefined}
        />
        <SectionFooter>{'A JSON object, for example { "API_BASE": "https://…" }.'}</SectionFooter>
      </View>
      <Button role="prominent" busy={busy} onPress={() => void save()}>
        Save
      </Button>
    </View>
  );
}
