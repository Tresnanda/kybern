import { Stack } from "expo-router";
import { NavigationBar } from "expo-navigation-bar";
import * as SystemUI from "expo-system-ui";
import { Platform, useWindowDimensions, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useEffect, type ReactNode } from "react";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { boot } from "../src/state/runtime";
import {
  hydrateLayout,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SPLIT_MIN_WIDTH,
  useLayout,
} from "../src/state/layout";
import { PANE } from "../src/components/liquid/motion";
import { Sidebar } from "../src/features/Sidebar";
import { ThemeProvider, useTheme } from "../src/ui/theme";

import {
  AndroidHeader,
  androidScreenLayout,
} from "../src/ui/AndroidNavigation";
import { SendTransitionProvider } from "../src/components/liquid/SendTransition";
import { DialogHost } from "../src/ui/Alert";

// A sheet opened from a deep link still needs a destination to dismiss to.
export const unstable_settings = { anchor: "index" };

const androidSheet =
  Platform.OS === "android"
    ? {
        presentation: "transparentModal" as const,
        headerShown: false,
        animation: "none" as const,
        contentStyle: { backgroundColor: "transparent" },
      }
    : {};

// The split shell. To keep the sidebar collapse/reveal buttery, the detail is a
// FIXED-width layer that only ever slides (a transform) — never resizes — so the
// heavy conversation never re-runs Yoga mid-animation. The sidebar is an
// absolute layer that slides in from the left over the (empty) detail margin, and
// a drag handle on the seam resizes it. Below the split width, children render
// full-screen exactly as the phone stack does.
function Shell({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const { regular, sidebarOpen, sidebarWidth, setSidebarWidth } = useLayout();
  const { width: screenWidth } = useWindowDimensions();
  // In the phone stack the detail fills the screen; in the split it leaves room
  // for the rail. Either way the detail keeps the same tree slot, so the native
  // navigator never remounts when a window crosses the split width.
  const detailWidth = regular
    ? Math.max(360, screenWidth - sidebarWidth)
    : screenWidth;

  const split = useSharedValue(regular ? 1 : 0);
  const open = useSharedValue(regular && sidebarOpen ? 1 : 0);
  const liveWidth = useSharedValue(sidebarWidth);
  const startWidth = useSharedValue(sidebarWidth);
  useEffect(() => {
    split.value = withSpring(regular ? 1 : 0, PANE);
  }, [regular, split]);
  useEffect(() => {
    open.value = withSpring(regular && sidebarOpen ? 1 : 0, PANE);
  }, [regular, sidebarOpen, open]);
  useEffect(() => {
    liveWidth.value = withSpring(sidebarWidth, PANE);
  }, [sidebarWidth, liveWidth]);

  const sidebarStyle = useAnimatedStyle(() => ({
    width: liveWidth.value,
    transform: [{ translateX: (open.value - 1) * liveWidth.value }],
  }));
  // Compact: detail fills the screen (no shift). Split, closed: centered. Split,
  // open: sits just right of the sidebar.
  const detailStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: split.value * liveWidth.value * (0.5 + 0.5 * open.value) },
    ],
  }));
  const handleStyle = useAnimatedStyle(() => ({
    opacity: open.value,
    transform: [{ translateX: liveWidth.value * open.value }],
  }));

  const resize = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .onStart(() => {
      startWidth.value = liveWidth.value;
    })
    .onUpdate((e) => {
      const raw = startWidth.value + e.translationX;
      // Rubber-band past the clamp so the edge resists instead of walling.
      liveWidth.value =
        raw < SIDEBAR_MIN_WIDTH
          ? SIDEBAR_MIN_WIDTH - (SIDEBAR_MIN_WIDTH - raw) * 0.2
          : raw > SIDEBAR_MAX_WIDTH
            ? SIDEBAR_MAX_WIDTH + (raw - SIDEBAR_MAX_WIDTH) * 0.2
            : raw;
    })
    .onEnd(() => {
      const w = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, liveWidth.value),
      );
      liveWidth.value = withSpring(w, PANE);
      scheduleOnRN(setSidebarWidth, w);
    });

  return (
    <View
      style={{
        flex: 1,
        overflow: "hidden",
        backgroundColor: colors.background,
      }}
    >
      <Animated.View
        style={[
          {
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: detailWidth,
            backgroundColor: colors.background,
          },
          detailStyle,
        ]}
      >
        {children}
      </Animated.View>
      {regular && (
        <>
          <Animated.View
            style={[
              {
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                backgroundColor: colors.background,
                borderRightWidth: 0.5,
                borderColor: colors.line,
              },
              sidebarStyle,
            ]}
          >
            <Sidebar />
          </Animated.View>
          <GestureDetector gesture={resize}>
            <Animated.View
              pointerEvents={sidebarOpen ? "auto" : "none"}
              style={[
                { position: "absolute", top: 0, bottom: 0, left: -12, width: 24 },
                handleStyle,
              ]}
            >
              <View
                style={{
                  flex: 1,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <View
                  style={{
                    width: 4,
                    height: 46,
                    borderRadius: 2,
                    backgroundColor: colors.line,
                  }}
                />
              </View>
            </Animated.View>
          </GestureDetector>
        </>
      )}
    </View>
  );
}

function Navigation() {
  const { colors, dark } = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  // On tablet iOS centers a form sheet; a full-height detent fills the screen so
  // it reads as grounded rather than a card floating in the middle.
  const sheetDetents = width >= SPLIT_MIN_WIDTH ? [1] : [0.75, 1];
  useEffect(() => {
    void boot();
    hydrateLayout();
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={dark ? "light" : "dark"} />
      <NavigationBar style={dark ? "light" : "dark"} />
      <Shell>
      <Stack
        screenLayout={
          Platform.OS === "android" ? androidScreenLayout : undefined
        }
        screenOptions={{
          headerShadowVisible: false,
          header:
            Platform.OS === "android"
              ? (props) => <AndroidHeader {...props} />
              : undefined,
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
          options={({ route }) => ({
            title: "",
            headerShown: false,
            // The composer-to-message flight already supplies this transition.
            ...((route.params as { created?: string } | undefined)?.created ===
            "1"
              ? { animation: "none" as const }
              : {}),
          })}
        />
        <Stack.Screen
          name="connect"
          options={{
            title: "Connect a computer",
            presentation: "modal",
            ...androidSheet,
          }}
        />
        <Stack.Screen
          name="configure"
          options={{
            title: "Thread setup",
            presentation: "formSheet",
            sheetAllowedDetents: sheetDetents,
            sheetGrabberVisible: true,
            ...androidSheet,
          }}
        />
        <Stack.Screen name="tasks" options={{ title: "Tasks & agents" }} />
        <Stack.Screen name="file" options={{ title: "File" }} />
        <Stack.Screen name="workspace" options={{ title: "Workspace" }} />
        <Stack.Screen
          name="integrations"
          options={{ title: "Connectors and plugins" }}
        />
        <Stack.Screen name="artifact" options={{ title: "Artifact" }} />
        <Stack.Screen name="scan-pairing" options={{ title: "Scan QR code" }} />
        <Stack.Screen
          name="project-picker"
          options={{
            title: "Choose project",
            presentation: "formSheet",
            sheetAllowedDetents: sheetDetents,
            sheetGrabberVisible: true,
            ...androidSheet,
          }}
        />
        <Stack.Screen name="add-project" options={{ title: "Add project" }} />
        <Stack.Screen
          name="capabilities"
          options={{
            title: "Add to message",
            presentation: "formSheet",
            sheetAllowedDetents: sheetDetents,
            sheetGrabberVisible: true,
            ...androidSheet,
          }}
        />
        <Stack.Screen
          name="composer-options"
          options={{
            presentation: "formSheet",
            sheetAllowedDetents: sheetDetents,
            sheetGrabberVisible: true,
            ...androidSheet,
          }}
        />
        <Stack.Screen name="settings-detail" options={{ title: "Settings" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="app-updates" options={{ title: "App updates" }} />
        <Stack.Screen name="projects" options={{ title: "Projects" }} />
        <Stack.Screen name="activity" options={{ title: "Activity" }} />
        <Stack.Screen name="sessions" options={{ title: "Resume a session" }} />
        <Stack.Screen name="pair" options={{ headerShown: false }} />
      </Stack>
      </Shell>
      <DialogHost />
    </View>
  );
}
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider>
          <SendTransitionProvider>
            <Navigation />
          </SendTransitionProvider>
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
