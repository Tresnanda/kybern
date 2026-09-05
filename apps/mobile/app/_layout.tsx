import React, { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionProvider, useConnection } from "@/connection/ConnectionContext";
import { parsePairingUrl } from "@/connection/pairing";
import { useDaemonSync } from "@/state/daemon";
import { useTheme } from "@/ui/theme";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <ConnectionProvider>
            <DaemonSync />
            <PairingLinkHandler />
            <Navigator />
          </ConnectionProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

function Navigator() {
  const th = useTheme();
  const base = th.dark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: { ...base.colors, background: th.canvas, card: th.canvas, text: th.text, primary: th.text, border: th.hairline },
  };
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style={th.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerTransparent: Platform.OS === "ios",
          headerShadowVisible: false,
          headerTintColor: th.text,
          headerTitleStyle: { fontWeight: "600" },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: th.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
        <Stack.Screen
          name="thread/new"
          options={{
            presentation: "formSheet",
            sheetGrabberVisible: true,
            sheetAllowedDetents: [0.82, 1],
            sheetCornerRadius: 28,
            headerShown: false,
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}

function DaemonSync() {
  const { client } = useConnection();
  useDaemonSync(client);
  return null;
}

/** `kybern://pair?url=...&code=...&environment=...` from the desktop app. */
function PairingLinkHandler() {
  const url = Linking.useLinkingURL();
  const { ready } = useConnection();
  const router = useRouter();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !url || handled.current === url) return;
    const pairing = parsePairingUrl(url);
    if (!pairing) return;
    handled.current = url;
    router.replace({ pathname: "/connect", params: { url: pairing.url, code: pairing.code, environment: pairing.environmentId } });
  }, [ready, url, router]);

  return null;
}
