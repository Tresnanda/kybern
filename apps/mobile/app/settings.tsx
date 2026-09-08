import { router } from "expo-router";
import Constants from "expo-constants";
import { View } from "react-native";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { Group, Page, Row, T, type IconName } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function SettingsScreen() {
  const app = useApp();
  const { colors, appearance } = useTheme();
  const environment = activeEnvironment();
  const row = (
    category: string,
    title: string,
    detail: string,
    icon: IconName,
  ) => (
    <Row
      key={category}
      title={title}
      detail={detail}
      icon={icon}
      onPress={() =>
        router.push({ pathname: "/settings-detail", params: { category } })
      }
    />
  );
  const card = {
    backgroundColor: colors.raised,
    borderRadius: 24,
    paddingHorizontal: 18,
  };
  return (
    <Page>
      <Group title="On this phone">
        <View style={card}>
          {row(
            "appearance",
            "Appearance",
            appearance === "system"
              ? "Match device"
              : appearance === "dark"
                ? "Dark"
                : "Light",
            "circle.lefthalf.filled",
          )}
          {row(
            "computers",
            "Computers",
            environment
              ? `${environment.name} · ${app.status === "open" ? "Connected" : "Disconnected"}`
              : "Connect your computer",
            "laptopcomputer",
          )}
          <Row
            title="App updates"
            detail="Check for updates to Kybern on this phone"
            icon="arrow.clockwise"
            onPress={() => router.push("/app-updates")}
          />
        </View>
      </Group>
      <Group
        title={environment ? `On ${environment.name}` : "On your computer"}
      >
        <View style={card}>
          {row(
            "defaults",
            "Thread defaults",
            "Permissions, worktrees, notifications",
            "slider.horizontal.3",
          )}
          {row("agents", "Agents", "Models and configuration", "sparkles")}
          {row("usage", "Usage", "Costs, tokens, and turns", "chart.bar")}
          {row(
            "system",
            "Background & updates",
            "Power, idle limits, and versions",
            "arrow.clockwise",
          )}
          {row(
            "access",
            "Access",
            "Paired devices and Tailscale",
            "lock.shield",
          )}
        </View>
      </Group>
      <T variant="caption" tone="muted">
        Kybern for mobile · {Constants.expoConfig?.version ?? Constants.nativeAppVersion}
      </T>
    </Page>
  );
}
