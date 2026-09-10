import { router } from "expo-router";
import Constants from "expo-constants";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { useLayout } from "../src/state/layout";
import {
  Group,
  Icon,
  Page,
  Row,
  T,
  Tap,
  type IconName,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";
import { SettingsBody, titles as SETTINGS_TITLES } from "./settings-detail";

type Category = {
  category: string;
  title: string;
  detail: string;
  icon: IconName;
};

// The selectable category list shown in the wide master-detail rail.
function SettingsRail({
  label,
  items,
  selected,
  onSelect,
}: {
  label: string;
  items: Category[];
  selected: string;
  onSelect: (category: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ marginBottom: 18 }}>
      <T variant="caption" tone="secondary" style={{ marginBottom: 4, paddingHorizontal: 12 }}>
        {label}
      </T>
      {items.map((item) => {
        const active = item.category === selected;
        return (
          <Tap
            key={item.category}
            label={item.title}
            selected={active}
            onPress={() => onSelect(item.category)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: 12,
              paddingHorizontal: 12,
              paddingVertical: 11,
              borderRadius: 12,
              backgroundColor: active ? colors.raised : undefined,
            }}
          >
            <Icon
              name={item.icon}
              size={19}
              color={active ? colors.ink : colors.secondary}
            />
            <T variant="label" numberOfLines={1} style={{ flex: 1 }}>
              {item.title}
            </T>
          </Tap>
        );
      })}
    </View>
  );
}

export default function SettingsScreen() {
  const app = useApp();
  const { colors, appearance } = useTheme();
  const { regular } = useLayout();
  const environment = activeEnvironment();
  const [selected, setSelected] = useState("appearance");

  const appearanceDetail =
    appearance === "system"
      ? "Match device"
      : appearance === "dark"
        ? "Dark"
        : "Light";
  const computersDetail = environment
    ? `${environment.name} · ${app.status === "open" ? "Connected" : "Disconnected"}`
    : "Connect your computer";
  const version = `Kybern for mobile · ${Constants.expoConfig?.version ?? Constants.nativeAppVersion}`;

  const phone: Category[] = [
    {
      category: "appearance",
      title: "Appearance",
      detail: appearanceDetail,
      icon: "circle.lefthalf.filled",
    },
    {
      category: "computers",
      title: "Computers",
      detail: computersDetail,
      icon: "laptopcomputer",
    },
  ];
  const computer: Category[] = [
    {
      category: "defaults",
      title: "Thread defaults",
      detail: "Permissions, worktrees, notifications",
      icon: "slider.horizontal.3",
    },
    {
      category: "agents",
      title: "Agents",
      detail: "Models and configuration",
      icon: "sparkles",
    },
    {
      category: "usage",
      title: "Usage",
      detail: "Costs, tokens, and turns",
      icon: "chart.bar",
    },
    {
      category: "system",
      title: "Background & updates",
      detail: "Power, idle limits, and versions",
      icon: "arrow.clockwise",
    },
    {
      category: "access",
      title: "Access",
      detail: "Paired devices and Tailscale",
      icon: "lock.shield",
    },
  ];

  if (regular) {
    return (
      <View
        style={{
          flex: 1,
          flexDirection: "row",
          backgroundColor: colors.background,
        }}
      >
        <View
          style={{
            width: 300,
            borderRightWidth: 0.5,
            borderColor: colors.line,
          }}
        >
          <ScrollView
            contentContainerStyle={{ padding: 14, paddingTop: 20 }}
            showsVerticalScrollIndicator={false}
          >
            <SettingsRail
              label="On this phone"
              items={phone}
              selected={selected}
              onSelect={setSelected}
            />
            <View style={{ marginBottom: 18 }}>
              <Tap
                label="App updates"
                onPress={() => router.push("/app-updates")}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "flex-start",
                  gap: 12,
                  paddingHorizontal: 12,
                  paddingVertical: 11,
                  borderRadius: 12,
                }}
              >
                <Icon name="arrow.clockwise" size={19} color={colors.secondary} />
                <T variant="label" style={{ flex: 1 }}>
                  App updates
                </T>
                <Icon name="chevron.right" size={12} color={colors.muted} />
              </Tap>
            </View>
            <SettingsRail
              label={environment ? `On ${environment.name}` : "On your computer"}
              items={computer}
              selected={selected}
              onSelect={setSelected}
            />
          </ScrollView>
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            padding: 24,
            width: "100%",
            maxWidth: 760,
            alignSelf: "center",
          }}
        >
          <T variant="title" style={{ marginBottom: 18 }}>
            {SETTINGS_TITLES[selected] ?? "Settings"}
          </T>
          <SettingsBody category={selected} />
          <T variant="caption" tone="muted" style={{ marginTop: 24 }}>
            {version}
          </T>
        </ScrollView>
      </View>
    );
  }

  const card = {
    backgroundColor: colors.raised,
    borderRadius: 24,
    paddingHorizontal: 18,
  };
  const row = (item: Category) => (
    <Row
      key={item.category}
      title={item.title}
      detail={item.detail}
      icon={item.icon}
      onPress={() =>
        router.push({
          pathname: "/settings-detail",
          params: { category: item.category },
        })
      }
    />
  );
  return (
    <Page>
      <Group title="On this phone">
        <View style={card}>
          {phone.map(row)}
          <Row
            title="App updates"
            detail="Check for updates to Kybern on this phone"
            icon="arrow.clockwise"
            onPress={() => router.push("/app-updates")}
          />
        </View>
      </Group>
      <Group title={environment ? `On ${environment.name}` : "On your computer"}>
        <View style={card}>{computer.map(row)}</View>
      </Group>
      <T variant="caption" tone="muted">
        {version}
      </T>
    </Page>
  );
}
