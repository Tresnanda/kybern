import { router } from "expo-router";
import { useState } from "react";
import { connect, errorText, removeEnvironment, useApp } from "../../state/runtime";
import { confirm } from "../../ui/Alert";
import { ListRow } from "../../ui/List";
import { ErrorBanner } from "../../ui/primitives";
import { Section } from "./common";
import { connectionRoute, shortAddress } from "./labels";

const STATUS: Record<string, string> = {
  open: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  failed: "Can't connect",
  closed: "Disconnected",
  idle: "Disconnected",
};

export function ComputersSettings() {
  const app = useApp();
  const [error, setError] = useState("");
  const forget = (id: string, name: string) =>
    confirm({
      title: `Forget “${name}”?`,
      message:
        "This removes the saved connection from this phone. Your projects and conversations stay on the computer.",
      confirm: "Forget computer",
      onConfirm: () => {
        void removeEnvironment(id).catch((e) => setError(errorText(e)));
      },
    });
  return (
    <>
      <ErrorBanner error={error} />
      <Section
        title="Your computers"
        first
        footer={app.environments.length ? "Tap a computer to switch to it. Touch and hold for more." : null}
      >
        {app.environments.map((env) => {
          const active = env.id === app.activeId;
          return (
            <ListRow
              key={env.id}
              title={env.name}
              subtitle={
                active
                  ? `${STATUS[app.status] ?? "Disconnected"} · ${connectionRoute(env.url)}`
                  : `${shortAddress(env.url)} · ${connectionRoute(env.url)}`
              }
              leading="laptopcomputer"
              checked={active}
              onPress={() => {
                if (!active) connect(env.id);
              }}
              menu={[
                ...(active ? [] : [{ title: "Switch to this computer", icon: "laptopcomputer" as const, onPress: () => connect(env.id) }]),
                ...(active && app.status !== "open"
                  ? [{ title: "Reconnect", icon: "arrow.clockwise" as const, onPress: () => connect(env.id) }]
                  : []),
                { title: "Forget computer", icon: "trash" as const, destructive: true, onPress: () => forget(env.id, env.name) },
              ]}
            />
          );
        })}
        <ListRow title="Connect a computer" leading="plus" onPress={() => router.push("/connect")} />
      </Section>
    </>
  );
}
