// The stack each tab hosts: transparent large-title header so content scrolls
// under the glass, and the canvas color behind every screen.

import React from "react";
import { Platform } from "react-native";
import { Stack } from "expo-router";
import { useTheme } from "./theme";

export function TabStack({ children }: { children?: React.ReactNode }) {
  const th = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTransparent: Platform.OS === "ios",
        headerShadowVisible: false,
        headerTintColor: th.text,
        headerTitleStyle: { fontWeight: "600" },
        headerLargeTitleStyle: { fontWeight: "700" },
        headerBackButtonDisplayMode: "minimal",
        contentStyle: { backgroundColor: th.canvas },
      }}
    >
      {children}
    </Stack>
  );
}
