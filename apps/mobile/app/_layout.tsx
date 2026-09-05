import React, { useEffect, useRef } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConnectionProvider, useConnection } from "@/connection/ConnectionContext";
import { parsePairingUrl } from "@/connection/pairing";
import { useTheme } from "@/ui/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ConnectionProvider>
        <PairingLinkHandler />
        <Navigator />
      </ConnectionProvider>
    </SafeAreaProvider>
  );
}

function Navigator() {
  const th = useTheme();
  return (
    <>
      <StatusBar style={th.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: th.canvas },
          headerTintColor: th.text,
          headerTitleStyle: { fontWeight: "600" },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: th.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ title: "Connect" }} />
        <Stack.Screen name="threads" options={{ title: "Threads" }} />
        <Stack.Screen name="thread/new" options={{ title: "New thread" }} />
        <Stack.Screen name="thread/[id]" options={{ title: "" }} />
      </Stack>
    </>
  );
}

/** `kybern://pair?url=...&code=...&environment=...` from a QR code or the desktop app. */
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
