import React from "react";
import { StyleSheet, View } from "react-native";
import type { ThreadStatus } from "@/protocol";
import { useTheme } from "./theme";

export function statusColor(status: ThreadStatus, th: ReturnType<typeof useTheme>): string | null {
  switch (status) {
    case "running":
      return th.running;
    case "awaiting-approval":
      return th.waiting;
    case "failed":
      return th.failed;
    default:
      return null;
  }
}

export function statusLabel(status: ThreadStatus): string | null {
  switch (status) {
    case "running":
      return "Working";
    case "awaiting-approval":
      return "Needs approval";
    case "failed":
      return "Failed";
    case "archived":
      return "Archived";
    default:
      return null;
  }
}

/** 8px dot; renders an empty spacer for idle so titles align. */
export function StatusDot({ status }: { status: ThreadStatus }) {
  const th = useTheme();
  const color = statusColor(status, th);
  return <View accessibilityLabel={statusLabel(status) ?? undefined} style={[styles.dot, { backgroundColor: color ?? "transparent" }]} />;
}

const styles = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
});
