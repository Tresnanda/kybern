// The computer this phone works with, one tap from Home: the header title shows it
// with its connection, and its menu switches to another saved computer, adds one,
// or opens Settings → Computers. Switching reconnects; the lists refill from the
// new computer (`connect` resets everything tied to the old one).
import { router } from "expo-router";
import { View } from "react-native";
import { connect, useApp } from "../state/runtime";
import { MenuButton } from "../ui/ActionMenu";
import { Brand } from "../ui/Brand";
import type { MenuItem } from "../ui/menuModel";
import { Icon, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { connectionLabel, connectionRoute, shortAddress } from "./settings/labels";

/** "MacBook Pro ✓ / Studio / Add a computer… / Manage computers…" as menu sections. */
export function useComputerMenuItems(): MenuItem[] {
  const app = useApp();
  if (!app.environments.length) return [];
  const offline = app.status === "failed" || app.status === "closed" || app.status === "idle";
  return [
    {
      title: "Computers",
      inline: true,
      children: app.environments.map<MenuItem>((env) => {
        const active = env.id === app.activeId;
        // Two computers with one name are told apart by their address.
        const named = app.environments.filter((other) => other.name === env.name).length > 1;
        const where = named ? shortAddress(env.url) : connectionRoute(env.url);
        return {
          title: env.name,
          subtitle: active ? `${connectionLabel(app.status)} · ${where}` : where,
          checked: active,
          onPress: () => {
            if (!active) connect(env.id);
          },
        };
      }),
    },
    {
      title: "Computer actions",
      inline: true,
      children: [
        ...(offline && app.activeId
          ? [{ title: "Reconnect", icon: "arrow.clockwise" as const, onPress: () => connect(app.activeId) }]
          : []),
        { title: "Add a computer…", icon: "plus", onPress: () => router.push("/connect") },
        {
          title: "Manage computers…",
          icon: "laptopcomputer",
          onPress: () => router.push({ pathname: "/settings-detail", params: { category: "computers" } }),
        },
      ],
    },
  ];
}

/** The connection as a 7 pt dot: green when connected, amber while connecting, grey otherwise. */
export function ConnectionDot({ status }: { status: string }) {
  const { colors } = useTheme();
  const color =
    status === "open" ? colors.positive : status === "connecting" || status === "reconnecting" ? colors.warning : colors.muted;
  return <View accessible={false} style={{ width: 7, height: 7, borderRadius: radius.full, backgroundColor: color }} />;
}

/**
 * Home's title: the active computer with its connection and a chevron, opening the
 * computer menu. Before any computer is saved it is the wordmark.
 */
export function ComputerSwitcher() {
  const { colors } = useTheme();
  const app = useApp();
  const items = useComputerMenuItems();
  const active = app.environments.find((env) => env.id === app.activeId);
  if (!items.length || !active)
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Brand size={20} />
        <T variant="headline">kybern</T>
      </View>
    );
  return (
    <MenuButton
      items={items}
      label={`Computer: ${active.name}, ${connectionLabel(app.status)}. Switch computer`}
      radius={radius.full}
      style={{ flexShrink: 1 }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          minHeight: 44,
          paddingHorizontal: space.md,
        }}
      >
        <ConnectionDot status={app.status} />
        <T variant="headline" numberOfLines={1} style={{ flexShrink: 1 }}>
          {active.name}
        </T>
        <Icon name="chevron.down" size={10} color={colors.muted} />
      </View>
    </MenuButton>
  );
}
