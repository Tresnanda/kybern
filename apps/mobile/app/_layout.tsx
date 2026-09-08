import { Stack } from "expo-router";
import { NavigationBar } from "expo-navigation-bar";
import * as SystemUI from "expo-system-ui";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useReducedMotion } from "react-native-reanimated";
import { boot } from "../src/state/runtime";
import { ThemeProvider, useTheme } from "../src/ui/theme";

function Navigation() {
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={dark ? "light" : "dark"} />
      <NavigationBar style={dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.ink,
          headerTitleStyle: { fontSize: 17, fontWeight: "500" },
          contentStyle: { backgroundColor: colors.background },
          headerBackButtonDisplayMode: "minimal",
          animation: reduced ? "fade" : "default",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen
          name="library"
          options={{ title: "Threads", headerLargeTitleEnabled: true }}
        />
        <Stack.Screen
          name="thread/[id]"
          options={{ title: "", headerShown: false }}
        />
        <Stack.Screen
          name="connect"
          options={{ title: "Connect a computer", presentation: "modal" }}
        />
        <Stack.Screen
          name="configure"
          options={{
            title: "Thread setup",
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="tasks" options={{ title: "Tasks & agents" }} />
        <Stack.Screen name="file" options={{ title: "File" }} />
        <Stack.Screen name="workspace" options={{ title: "Workspace" }} />
        <Stack.Screen name="scan-pairing" options={{ title: "Scan QR code" }} />
        <Stack.Screen
          name="project-picker"
          options={{
            title: "Choose project",
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="add-project" options={{ title: "Add project" }} />
        <Stack.Screen
          name="capabilities"
          options={{
            title: "Add to message",
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen
          name="composer-options"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
          }}
        />
        <Stack.Screen name="settings-detail" options={{ title: "Settings" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="projects" options={{ title: "Projects" }} />
        <Stack.Screen name="activity" options={{ title: "Activity" }} />
        <Stack.Screen name="sessions" options={{ title: "Resume a session" }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
      </Stack>
    </View>
  );
}
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider>
          <Navigation />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
