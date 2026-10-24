// General: what a new thread starts with, and how agents behave on this computer.
import { ASK_DEADLINE_DEFAULTS, askDeadlineOptions } from "../../../../../packages/kybern-client/src/requestCards";
import { PROVIDER_DISPLAY_NAME, type Settings } from "../../state/protocol";
import { useApp } from "../../state/runtime";
import { saveSettings, useSettings } from "../../state/settings";
import { ListRow } from "../../ui/List";
import { ProviderMark } from "../../ui/ProviderMark";
import { Section, ToggleRow, WithSettings } from "./common";
import { PERMISSION_LABELS, permissionLabel } from "./labels";

export function GeneralSettings() {
  return (
    <WithSettings>
      <GeneralBody />
    </WithSettings>
  );
}

function GeneralBody() {
  const app = useApp();
  const { settings: current } = useSettings();
  const settings = current!;
  const set = (patch: Partial<Settings>) => void saveSettings({ ...settings, ...patch });
  const provider = app.providers.find((p) => p.kind === settings.default_provider);
  const modes = provider?.supported_permission_modes?.length
    ? provider.supported_permission_modes
    : (Object.keys(PERMISSION_LABELS) as Settings["default_permission_mode"][]);
  const ask = settings.ask_deadlines ?? ASK_DEADLINE_DEFAULTS;
  return (
    <>
      <Section title="New threads" first footer="Threads you already started keep their own choices.">
        <ListRow
          title="Agent"
          leading={<ProviderMark kind={settings.default_provider} size={20} />}
          value={provider?.display_name ?? PROVIDER_DISPLAY_NAME[settings.default_provider] ?? settings.default_provider}
          valueMenu={app.providers
            .filter((p) => p.available || p.kind === settings.default_provider)
            .map((p) => ({
              title: p.display_name,
              checked: p.kind === settings.default_provider,
              onPress: () => set({ default_provider: p.kind }),
            }))}
        />
        <ListRow
          title="Permissions"
          leading="lock.shield"
          value={permissionLabel(settings.default_permission_mode)}
          valueMenu={modes.map((mode) => ({
            title: permissionLabel(mode),
            checked: mode === settings.default_permission_mode,
            onPress: () => set({ default_permission_mode: mode }),
          }))}
        />
        <ToggleRow
          title="Use a worktree"
          subtitle="Give each new thread its own checkout."
          value={settings.worktrees_default}
          onChange={(value) => set({ worktrees_default: value })}
        />
        <ToggleRow
          title="Name threads automatically"
          subtitle="An agent titles new conversations."
          value={settings.generate_titles}
          onChange={(value) => set({ generate_titles: value })}
        />
      </Section>
      <Section
        title="Worktrees"
        footer="Removes clean, merged worktrees after you archive a thread. Branches and conversations stay; continuing a thread restores its folder."
      >
        <ToggleRow
          title="Remove eligible archived worktrees"
          value={settings.automatic_worktree_cleanup ?? false}
          onChange={(value) => set({ automatic_worktree_cleanup: value })}
        />
      </Section>
      <Section
        title="Agents"
        footer="Adds a short guide to new agent sessions: how to show images, link notes and tasks, and reach other threads."
      >
        <ToggleRow
          title="Tell agents about Kybern"
          value={settings.tell_agents_about_kybern}
          onChange={(value) => set({ tell_agents_about_kybern: value })}
        />
      </Section>
      <Section
        title="Questions"
        footer={
          ask.enabled
            ? "An agent may set a default answer and a wait. When the wait ends, Kybern picks the default. Shorter requests keep their own time."
            : "Agents wait for your answer, however long it takes."
        }
      >
        <ToggleRow
          title="Let agents answer for you after a deadline"
          value={ask.enabled}
          onChange={(value) => set({ ask_deadlines: { ...ask, enabled: value } })}
        />
        {ask.enabled ? (
          <ListRow
            title="Longest wait"
            value={askDeadlineOptions(ask.max_seconds).find((o) => o.value === String(ask.max_seconds))?.label}
            valueMenu={askDeadlineOptions(ask.max_seconds).map((option) => ({
              title: option.label,
              checked: option.value === String(ask.max_seconds),
              onPress: () => set({ ask_deadlines: { ...ask, max_seconds: Number(option.value) } }),
            }))}
          />
        ) : null}
      </Section>
      <Section title="Notifications" footer="Notifications on this phone aren't available yet.">
        <ToggleRow
          title="Notify on the computer"
          subtitle="When work finishes or needs you."
          value={settings.notifications}
          onChange={(value) => set({ notifications: value })}
        />
      </Section>
    </>
  );
}
