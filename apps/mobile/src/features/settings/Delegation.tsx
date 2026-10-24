// Delegation: how many agents a thread may run, how deep they may delegate, and
// the Coordinator's defaults that every project follows unless it overrides them.
import { router } from "expo-router";
import {
  AUTONOMY_OPTIONS,
  COORDINATOR_ROLES,
  COORDINATOR_SETTINGS_COPY as COPY,
  WORKSPACE_OPTIONS,
  autonomyHint,
  effectiveCoordinatorSettings,
  roleChip,
} from "../../../../../packages/kybern-client/src/coordinatorSettings";
import type { OrchestrationSettings } from "../../state/protocol";
import { count } from "../../state/format";
import { useApp } from "../../state/runtime";
import { saveSettings, useSettings } from "../../state/settings";
import { ListRow } from "../../ui/List";
import { ProviderMark } from "../../ui/ProviderMark";
import { Section, ToggleRow, WithSettings } from "./common";
import { rangeChoices } from "./labels";

export function DelegationSettings() {
  return (
    <WithSettings>
      <DelegationBody />
    </WithSettings>
  );
}

function DelegationBody() {
  const app = useApp();
  const { settings: current } = useSettings();
  const settings = current!;
  const orchestration = settings.orchestration;
  const effective = effectiveCoordinatorSettings(orchestration, null);
  const change = (patch: Partial<OrchestrationSettings>) =>
    void saveSettings({ ...settings, orchestration: { ...orchestration, ...patch } });
  const limit = (
    title: string,
    value: number,
    max: number,
    key: "max_active_children" | "lead_max_children" | "max_depth",
    noun: [string, string],
  ) => (
    <ListRow
      title={title}
      value={count(value, noun[0], noun[1])}
      valueMenu={rangeChoices(1, max).map((n) => ({
        title: count(n, noun[0], noun[1]),
        checked: n === value,
        onPress: () => change({ [key]: n }),
      }))}
    />
  );
  return (
    <>
      <Section
        title="Limits"
        first
        footer="At a limit, a thread waits for one of its agents to finish before it delegates again. Depth 1 lets only top-level threads delegate."
      >
        {limit("Agents per thread", orchestration.max_active_children, 16, "max_active_children", ["agent", "agents"])}
        {limit("Agents per Coordinator", orchestration.lead_max_children, 16, "lead_max_children", ["agent", "agents"])}
        {limit("Delegation depth", orchestration.max_depth, 4, "max_depth", ["level", "levels"])}
      </Section>
      <Section title={COPY.defaultsSection} footer={autonomyHint(effective.lead_autonomy)}>
        <ListRow
          title={COPY.autonomy}
          value={AUTONOMY_OPTIONS.find((o) => o.value === effective.lead_autonomy)?.label}
          valueMenu={AUTONOMY_OPTIONS.map((option) => ({
            title: option.label,
            subtitle: option.hint,
            checked: option.value === effective.lead_autonomy,
            onPress: () => change({ lead_autonomy: option.value }),
          }))}
        />
        <ListRow
          title={COPY.workspace}
          value={WORKSPACE_OPTIONS.find((o) => o.value === effective.lead_workspace)?.label}
          valueMenu={WORKSPACE_OPTIONS.map((option) => ({
            title: option.label,
            checked: option.value === effective.lead_workspace,
            onPress: () => change({ lead_workspace: option.value }),
          }))}
        />
      </Section>
      <Section footer={COPY.pushDetail}>
        <ToggleRow
          title={COPY.push}
          value={effective.lead_push_without_asking}
          onChange={(value) => change({ lead_push_without_asking: value })}
        />
      </Section>
      <Section
        title={COPY.models}
        footer="Used when the Coordinator delegates without choosing a model. Each project can override these."
      >
        {COORDINATOR_ROLES.map(({ role, label }) => {
          const chip = roleChip(role, orchestration, null, app.providers, "global");
          return (
            <ListRow
              key={role}
              title={label}
              leading={chip.kind !== "coordinator" && chip.provider ? <ProviderMark kind={chip.provider.kind} size={20} /> : "sparkles"}
              value={chip.label}
              chevron
              onPress={() => router.push({ pathname: "/settings-role", params: { role } })}
            />
          );
        })}
      </Section>
    </>
  );
}
