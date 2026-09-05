// The native tab bar: Liquid Glass on iOS 26 (floats, minimizes on scroll),
// Material navigation bar on Android. Tabs never animate between each other.

import React from "react";
import { Platform } from "react-native";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useDaemon } from "@/state/daemon";
import { useTheme } from "@/ui/theme";

export default function TabsLayout() {
  const th = useTheme();
  const { approvals } = useDaemon();
  const pending = approvals.size;
  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={th.text}
      badgeBackgroundColor={th.waiting}
      iconColor={Platform.OS === "android" ? { default: th.textSecondary, selected: th.text } : undefined}
      backgroundColor={Platform.OS === "android" ? th.canvas : undefined}
      indicatorColor={Platform.OS === "android" ? th.surfaceRaised : undefined}
      labelStyle={Platform.OS === "android" ? { color: th.textSecondary } : undefined}
    >
      <NativeTabs.Trigger name="threads">
        <NativeTabs.Trigger.Icon sf={{ default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" }} md="forum" />
        <NativeTabs.Trigger.Label>Threads</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="approvals">
        <NativeTabs.Trigger.Icon sf={{ default: "checkmark.shield", selected: "checkmark.shield.fill" }} md="verified_user" />
        <NativeTabs.Trigger.Label>Approvals</NativeTabs.Trigger.Label>
        {pending > 0 ? <NativeTabs.Trigger.Badge>{String(pending)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} md="settings" />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
