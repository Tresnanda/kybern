// Connection state pill that drops in under the header while the socket is
// anything but open. Disappears the moment it is.

import React from "react";
import { StyleSheet, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import type { ConnectionStatus } from "@/protocol";
import { Glass } from "./Glass";
import { Txt } from "./Screen";
import { StatusGlyph } from "./StatusGlyph";
import { radius, space, useTheme } from "./theme";

export function connectionText(status: ConnectionStatus, detail?: string): string | null {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return detail ? `Reconnecting · ${detail}` : "Reconnecting…";
    case "closed":
    case "failed":
      return "Disconnected";
    default:
      return null;
  }
}

export function ConnectionBanner({ status, detail, error }: { status: ConnectionStatus; detail?: string; error?: string | null }) {
  const th = useTheme();
  const text = error ?? connectionText(status, detail);
  if (!text) return null;
  const bad = Boolean(error) || status === "closed" || status === "failed";
  return (
    <Animated.View entering={FadeInUp.springify().damping(18)} exiting={FadeOutUp.duration(140)} style={styles.wrap} pointerEvents="none">
      <Glass radius={radius.pill} style={styles.pill}>
        <View style={styles.inner}>
          <StatusGlyph status={bad ? "failed" : "running"} size={7} />
          <Txt variant="footnote" tone="secondary" color={bad ? th.failed : undefined} numberOfLines={1}>
            {text}
          </Txt>
        </View>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", zIndex: 10 },
  pill: { maxWidth: "80%" },
  inner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, height: 34 },
});
