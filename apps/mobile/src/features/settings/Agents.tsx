// Agents: the coding agents installed on the computer, their updates, and each
// one's executable, model and environment (on its own page).
import { router } from "expo-router";
import { useEffect, useState } from "react";
import type { HarnessUpdate } from "../../state/protocol";
import { errorText, rpc, useApp } from "../../state/runtime";
import { saveSettings, useSettings } from "../../state/settings";
import { ListRow } from "../../ui/List";
import { ErrorBanner } from "../../ui/primitives";
import { ProviderMark } from "../../ui/ProviderMark";
import { Section, ToggleRow, WithSettings } from "./common";
import { harnessUpdateLabel } from "./labels";

/** The harness update list, read once per page. */
export function useHarnessUpdates() {
  const app = useApp();
  const [updates, setUpdates] = useState<HarnessUpdate[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (app.status !== "open") return;
    let live = true;
    rpc("harness_updates.list", {})
      .then((result) => live && setUpdates(result.updates))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [app.status, app.activeId]);
  return { updates, setUpdates, error };
}

export function AgentsSettings() {
  return (
    <WithSettings>
      <AgentsBody />
    </WithSettings>
  );
}

function AgentsBody() {
  const app = useApp();
  const { settings: current } = useSettings();
  const settings = current!;
  const { updates, error } = useHarnessUpdates();
  const installed = app.providers.filter((p) => p.available);
  const missing = app.providers.filter((p) => !p.available);
  const row = (provider: (typeof app.providers)[number]) => {
    const update = updates.find((u) => u.kind === provider.kind);
    return (
      <ListRow
        key={provider.kind}
        title={provider.display_name}
        subtitle={
          provider.available
            ? [provider.version, update && update.status !== "current" && update.status !== "not_checked" ? harnessUpdateLabel(update.status) : null]
                .filter(Boolean)
                .join(" · ") || "Installed"
            : (provider.unavailable_reason ?? "Not installed on this computer")
        }
        subtitleLines={2}
        leading={<ProviderMark kind={provider.kind} size={22} />}
        chevron
        onPress={() => router.push({ pathname: "/settings-agent", params: { kind: provider.kind } })}
      />
    );
  };
  return (
    <>
      <ErrorBanner error={error} />
      <Section title="Installed" first>
        {installed.map(row)}
      </Section>
      {missing.length ? (
        <Section title="Not installed" footer="Install an agent on your computer, then come back.">
          {missing.map(row)}
        </Section>
      ) : null}
      <Section
        title="Updates"
        footer="Checks daily and installs when an agent's turns and background work are finished. Custom executables stay under your control."
      >
        <ToggleRow
          title="Update agents automatically"
          value={settings.auto_update_harnesses}
          onChange={(value) => void saveSettings({ ...settings, auto_update_harnesses: value })}
        />
      </Section>
    </>
  );
}
