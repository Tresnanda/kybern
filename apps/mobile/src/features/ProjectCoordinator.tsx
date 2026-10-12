// The Project sheet's Coordinator section on the phone: this project's overrides of the
// Coordinator settings over the computer's defaults (Settings › Delegation on desktop),
// and "Redo setup". Every change sends the whole override object with
// `projects.update { coordinator }`; it shows at once and goes back if the computer refuses.
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import {
  AUTONOMY_OPTIONS,
  COORDINATOR_ROLES,
  COORDINATOR_SETTINGS_COPY,
  WORKSPACE_OPTIONS,
  autonomyHint,
  effectiveCoordinatorSettings,
  roleChip,
  withOverrideField,
  type CoordinatorField,
} from "../../../../packages/kybern-client/src/coordinatorSettings";
import type { CoordinatorOverrides, OrchestrationSettings } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { Alert } from "../ui/Alert";
import { ErrorBanner, Icon, T, Tap, styles } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { Segmented } from "../ui/Segmented";
import { Toggle } from "../ui/Toggle";
import { useTheme } from "../ui/theme";
import { Pill } from "./NoteView";

/** The computer's global Coordinator defaults, read once per sheet. */
export function useOrchestrationDefaults(): OrchestrationSettings | null {
  const app = useApp();
  const [settings, setSettings] = useState<OrchestrationSettings | null>(null);
  useEffect(() => {
    if (app.status !== "open") return;
    let live = true;
    rpc("settings.get", {})
      .then((value) => live && setSettings(value.orchestration))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [app.status]);
  return settings;
}

/** Send the project's whole override object; `null` clears it. */
export function saveProjectCoordinator(projectId: string, next: CoordinatorOverrides | null) {
  return rpc("projects.update", { project_id: projectId, coordinator: next });
}

export function ProjectCoordinatorSection({ projectId }: { projectId: string }) {
  const { colors } = useTheme();
  const app = useApp();
  const saved = app.projects.find((project) => project.id === projectId)?.coordinator ?? null;
  const global = useOrchestrationDefaults();
  // Shown at once; `projects.changed` confirms it, a failure puts the saved value back.
  const [pending, setPending] = useState<{ value: CoordinatorOverrides | null } | null>(null);
  const [error, setError] = useState("");
  const overrides = pending ? pending.value : saved;
  const effective = useMemo(() => effectiveCoordinatorSettings(global, overrides), [global, overrides]);

  const write = (next: CoordinatorOverrides | null) => {
    setPending({ value: next });
    setError("");
    saveProjectCoordinator(projectId, next)
      .catch((e) => setError(`${COORDINATOR_SETTINGS_COPY.saveFailed} ${errorText(e)}`))
      .finally(() => setPending(null));
  };
  const setField = <K extends CoordinatorField>(field: K, value: CoordinatorOverrides[K]) => write(withOverrideField(overrides, field, value));

  const redo = () =>
    Alert.alert(COORDINATOR_SETTINGS_COPY.redoTitle, COORDINATOR_SETTINGS_COPY.redoDetail, [
      { text: "Cancel", style: "cancel" },
      {
        text: COORDINATOR_SETTINGS_COPY.redo,
        onPress: () => {
          setError("");
          rpc("coordinator.setup", { project_id: projectId }).catch((e) => setError(`${COORDINATOR_SETTINGS_COPY.redoFailed}. ${errorText(e)}`));
        },
      },
    ]);
  const reset = () =>
    Alert.alert(COORDINATOR_SETTINGS_COPY.resetTitle, COORDINATOR_SETTINGS_COPY.resetDetail, [
      { text: "Cancel", style: "cancel" },
      { text: COORDINATOR_SETTINGS_COPY.reset, style: "destructive", onPress: () => write(null) },
    ]);

  return (
    <View style={{ marginTop: 12 }}>
      <View style={[styles.spread, { minHeight: 44, paddingTop: 12 }]}>
        <T variant="caption" tone="secondary" accessibilityRole="header">{COORDINATOR_SETTINGS_COPY.section}</T>
        <Pill label={COORDINATOR_SETTINGS_COPY.redo} onPress={redo} />
      </View>
      <View style={{ gap: 18, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }}>
        <View style={{ gap: 8 }}>
          <T variant="caption" tone="secondary">{COORDINATOR_SETTINGS_COPY.autonomy}</T>
          <Segmented label={COORDINATOR_SETTINGS_COPY.autonomy} options={AUTONOMY_OPTIONS} value={effective.lead_autonomy} disabled={!!pending} onChange={(value) => setField("lead_autonomy", value)} />
          <T variant="caption" tone="muted">{autonomyHint(effective.lead_autonomy)}</T>
        </View>
        <View style={{ gap: 8 }}>
          <T variant="caption" tone="secondary">{COORDINATOR_SETTINGS_COPY.workspace}</T>
          <Segmented label={COORDINATOR_SETTINGS_COPY.workspace} options={WORKSPACE_OPTIONS} value={effective.lead_workspace} disabled={!!pending} onChange={(value) => setField("lead_workspace", value)} />
        </View>
        <View style={[styles.line, { gap: 12 }]}>
          <View style={{ flex: 1, gap: 2 }}>
            <T variant="label">{COORDINATOR_SETTINGS_COPY.push}</T>
            <T variant="caption" tone="secondary">{COORDINATOR_SETTINGS_COPY.pushDetail}</T>
          </View>
          <Toggle
            value={effective.lead_push_without_asking}
            disabled={!!pending}
            onValueChange={(value) => setField("lead_push_without_asking", value)}
            accessibilityLabel={COORDINATOR_SETTINGS_COPY.push}
          />
        </View>
        <View style={{ gap: 4 }}>
          <T variant="caption" tone="secondary">{COORDINATOR_SETTINGS_COPY.models}</T>
          <View>
            {COORDINATOR_ROLES.map(({ role, label }, index) => {
              const chip = roleChip(role, global, overrides, app.providers, "project");
              return (
                <Tap
                  key={role}
                  static
                  label={`${label} model: ${chip.label}. Change`}
                  disabled={!!pending}
                  onPress={() => router.push({ pathname: "/coordinator-model", params: { projectId, role } })}
                  style={[styles.line, { minHeight: 48, gap: 8, borderTopWidth: index ? 1 : 0, borderColor: colors.line }]}
                >
                  <T style={{ flex: 1 }}>{label}</T>
                  {chip.kind !== "coordinator" && chip.provider && <ProviderMark kind={chip.provider.kind} size={14} />}
                  <T variant="caption" tone={chip.kind === "set" ? "ink" : "muted"} numberOfLines={1} style={{ flexShrink: 1, maxWidth: "60%" }}>
                    {chip.label}
                  </T>
                  <Icon name="chevron.right" size={12} color={colors.muted} />
                </Tap>
              );
            })}
          </View>
        </View>
        <View style={[styles.spread, { gap: 8 }]}>
          <T variant="caption" tone="muted" style={{ flex: 1 }}>{COORDINATOR_SETTINGS_COPY.defaultsFrom}</T>
          <Tap label={COORDINATOR_SETTINGS_COPY.reset} disabled={!overrides || !!pending} onPress={reset} style={{ paddingHorizontal: 6, alignItems: "center" }}>
            <T variant="label" tone="accent">{COORDINATOR_SETTINGS_COPY.reset}</T>
          </Tap>
        </View>
      </View>
      <ErrorBanner error={error} />
    </View>
  );
}
