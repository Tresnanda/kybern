// Background & updates: what the computer keeps running after work finishes,
// and Kybern's own updates there.
import { useEffect, useState } from "react";
import { View } from "react-native";
import type { BackgroundSettings, DaemonActivity, DaemonUpdate } from "../../state/protocol";
import { count } from "../../state/format";
import { errorText, rpc, useApp } from "../../state/runtime";
import { saveSettings, useSettings } from "../../state/settings";
import { ListRow } from "../../ui/List";
import { Button, ErrorBanner } from "../../ui/primitives";
import { space } from "../../ui/theme";
import { Section, ToggleRow, WithSettings } from "./common";
import { daemonUpdateLabel } from "./labels";

export function SystemSettings() {
  return (
    <WithSettings>
      <SystemBody />
    </WithSettings>
  );
}

type LimitKey = Exclude<keyof BackgroundSettings, "save_power_on_battery">;
/** Each limit's choices; 0 turns it off. The current value joins the list when it isn't one of them. */
const LIMITS: { key: LimitKey; title: string; choices: number[]; unit: "minutes" | "sessions" }[] = [
  { key: "session_idle_minutes", title: "Release idle agents after", choices: [0, 5, 10, 15, 30, 60, 120], unit: "minutes" },
  { key: "max_idle_sessions", title: "Idle agents kept", choices: [0, 1, 2, 3, 5, 8, 12], unit: "sessions" },
  { key: "terminal_idle_minutes", title: "Close idle terminals after", choices: [0, 15, 30, 60, 120, 240], unit: "minutes" },
  { key: "daemon_idle_exit_minutes", title: "Stop Kybern when idle after", choices: [0, 15, 30, 60, 120, 240, 480], unit: "minutes" },
];

export function limitValueLabel(value: number, unit: "minutes" | "sessions") {
  if (value === 0) return unit === "minutes" ? "Never" : "No limit";
  if (unit === "sessions") return String(value);
  if (value < 60 || value % 60) return count(value, "minute");
  return count(value / 60, "hour");
}

function SystemBody() {
  const app = useApp();
  const { settings: current } = useSettings();
  const settings = current!;
  const [activity, setActivity] = useState<DaemonActivity>();
  const [update, setUpdate] = useState<DaemonUpdate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([rpc("daemon.activity", {}), rpc("daemon_update.status", {})])
      .then(([a, u]) => {
        if (!live) return;
        setActivity(a);
        setUpdate(u);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [app.activeId]);
  const daemonAction = () => {
    setBusy(true);
    setError("");
    rpc(update?.status === "available" ? "daemon_update.run" : "daemon_update.check", {})
      .then(setUpdate)
      .catch((e) => setError(`Unable to update Kybern. ${errorText(e)}`))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <ErrorBanner error={error} />
      <Section
        title="Running now"
        first
        footer={activity ? [count(activity.live_sessions, "agent session"), count(activity.terminals, "terminal"), count(activity.running_threads, "running thread")].join(" · ") : null}
      >
        <ToggleRow
          title="Save power on battery"
          subtitle="Release idle agents sooner and pause automatic updates."
          value={settings.background.save_power_on_battery}
          onChange={(value) =>
            void saveSettings({ ...settings, background: { ...settings.background, save_power_on_battery: value } })
          }
        />
      </Section>
      <BackgroundLimits />
      <Section title="Kybern on the computer" footer={update?.message || null}>
        <ListRow title="Version" value={update?.current_version ?? app.status} />
        {update ? (
          <ListRow
            title="Status"
            value={update.status === "available" && update.latest_version ? `${update.latest_version} available` : daemonUpdateLabel(update.status)}
          />
        ) : null}
        <ToggleRow
          title="Update Kybern automatically"
          subtitle="Installs when nothing is running."
          value={settings.auto_update_daemon}
          onChange={(value) => void saveSettings({ ...settings, auto_update_daemon: value })}
        />
      </Section>
      {update && update.status !== "unsupported" ? (
        <View style={{ marginTop: space.lg }}>
          <Button
            icon="arrow.clockwise"
            busy={busy || ["checking", "updating", "restarting"].includes(update.status)}
            onPress={daemonAction}
          >
            {update.status === "available" ? "Update Kybern" : "Check for an update"}
          </Button>
        </View>
      ) : null}
    </>
  );
}

function BackgroundLimits() {
  const { settings: current } = useSettings();
  const settings = current!;
  return (
    <Section title="When work finishes" footer="Shorter limits free memory and battery sooner; agents start again when you send a message.">
      {LIMITS.map(({ key, title, choices, unit }) => {
        const value = settings.background[key];
        const list = choices.includes(value) ? choices : [...choices, value].sort((a, b) => a - b);
        return (
          <ListRow
            key={key}
            title={title}
            value={limitValueLabel(value, unit)}
            valueMenu={list.map((choice) => ({
              title: limitValueLabel(choice, unit),
              checked: choice === value,
              onPress: () => void saveSettings({ ...settings, background: { ...settings.background, [key]: choice } }),
            }))}
          />
        );
      })}
    </Section>
  );
}
