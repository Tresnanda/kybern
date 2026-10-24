// The Project sheet's Coordinator section on the phone: this project's overrides of the
// Coordinator settings over the computer's defaults (Settings › Delegation on desktop),
// and "Redo setup". Every change sends the whole override object with
// `projects.update { coordinator }`; it shows at once and goes back if the computer refuses.
import { router } from "expo-router";
import { useMemo, useState } from "react";
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
import { useSettings } from "../state/settings";
import { confirm } from "../ui/Alert";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import type { MenuItem } from "../ui/menuModel";
import { ErrorBanner } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { Toggle } from "../ui/Toggle";

/** The computer's global Coordinator defaults, live (`settings.changed`). */
export function useOrchestrationDefaults(): OrchestrationSettings | null {
  return useSettings().settings?.orchestration ?? null;
}

/** Send the project's whole override object; `null` clears it. */
export function saveProjectCoordinator(projectId: string, next: CoordinatorOverrides | null) {
  return rpc("projects.update", { project_id: projectId, coordinator: next });
}

export function ProjectCoordinatorSection({ projectId }: { projectId: string }) {
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
    confirm({
      title: COORDINATOR_SETTINGS_COPY.redoTitle,
      message: COORDINATOR_SETTINGS_COPY.redoDetail,
      confirm: COORDINATOR_SETTINGS_COPY.redo,
      destructive: false,
      onConfirm: () => {
        setError("");
        rpc("coordinator.setup", { project_id: projectId }).catch((e) => setError(`${COORDINATOR_SETTINGS_COPY.redoFailed}. ${errorText(e)}`));
      },
    });
  const reset = () =>
    confirm({
      title: COORDINATOR_SETTINGS_COPY.resetTitle,
      message: COORDINATOR_SETTINGS_COPY.resetDetail,
      confirm: COORDINATOR_SETTINGS_COPY.reset,
      onConfirm: () => write(null),
    });
  const choice = <V extends string>(options: readonly { value: V; label: string }[], value: V, field: CoordinatorField): MenuItem[] =>
    options.map((option) => ({
      title: option.label,
      checked: option.value === value,
      onPress: () => setField(field, option.value as never),
    }));

  return (
    <View>
      <SectionHeader
        title={COORDINATOR_SETTINGS_COPY.section}
        inset
        action={{ title: COORDINATOR_SETTINGS_COPY.redo, onPress: redo }}
      />
      <InsetGroup>
        <ListRow
          title={COORDINATOR_SETTINGS_COPY.autonomy}
          subtitle={autonomyHint(effective.lead_autonomy)}
          value={AUTONOMY_OPTIONS.find((o) => o.value === effective.lead_autonomy)?.label}
          valueMenu={choice(AUTONOMY_OPTIONS, effective.lead_autonomy, "lead_autonomy")}
          disabled={!!pending}
        />
        <ListRow
          title={COORDINATOR_SETTINGS_COPY.workspace}
          value={WORKSPACE_OPTIONS.find((o) => o.value === effective.lead_workspace)?.label}
          valueMenu={choice(WORKSPACE_OPTIONS, effective.lead_workspace, "lead_workspace")}
          disabled={!!pending}
        />
        <ListRow
          title={COORDINATOR_SETTINGS_COPY.push}
          subtitle={COORDINATOR_SETTINGS_COPY.pushDetail}
          trailing={
            <Toggle
              value={effective.lead_push_without_asking}
              disabled={!!pending}
              onValueChange={(value) => setField("lead_push_without_asking", value)}
              accessibilityLabel={COORDINATOR_SETTINGS_COPY.push}
            />
          }
        />
      </InsetGroup>
      <SectionHeader title={COORDINATOR_SETTINGS_COPY.models} inset />
      <InsetGroup>
        {COORDINATOR_ROLES.map(({ role, label }) => {
          const chip = roleChip(role, global, overrides, app.providers, "project");
          return (
            <ListRow
              key={role}
              title={label}
              leading={chip.kind !== "coordinator" && chip.provider ? <ProviderMark kind={chip.provider.kind} size={18} /> : undefined}
              value={chip.label}
              chevron
              disabled={!!pending}
              label={`${label} model: ${chip.label}. Change`}
              onPress={() => router.push({ pathname: "/coordinator-model", params: { projectId, role } })}
            />
          );
        })}
        <ListRow title={COORDINATOR_SETTINGS_COPY.reset} destructive disabled={!overrides || !!pending} onPress={reset} />
      </InsetGroup>
      <SectionFooter inset>{COORDINATOR_SETTINGS_COPY.defaultsFrom}</SectionFooter>
      <ErrorBanner error={error} />
    </View>
  );
}
