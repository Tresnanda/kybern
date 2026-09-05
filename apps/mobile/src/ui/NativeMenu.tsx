// A dropdown of actions. On iOS this is a real SwiftUI Menu on a glass button,
// so it gets the system's morph, blur and haptics for free. Android gets a
// glass popover drawn by us with the same items.

import React, { useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Txt } from "./Screen";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

export interface MenuItem {
  title: string;
  icon?: IconName;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface Props {
  items: MenuItem[];
  /** Trigger glyph; defaults to an ellipsis circle. */
  icon?: IconName;
  accessibilityLabel: string;
  size?: number;
}

export function NativeMenu(props: Props) {
  if (Platform.OS === "ios") return <IOSMenu {...props} />;
  return <FallbackMenu {...props} />;
}

function IOSMenu({ items, icon = "more", size = 36 }: Props) {
  // Required lazily so the module never loads on Android.
  const ui = require("@expo/ui/swift-ui") as typeof import("@expo/ui/swift-ui");
  const mods = require("@expo/ui/swift-ui/modifiers") as typeof import("@expo/ui/swift-ui/modifiers");
  const { ICONS } = require("./Icon") as typeof import("./Icon");
  return (
    <ui.Host matchContents style={{ height: size }}>
      <ui.Menu
        label=""
        systemImage={ICONS[icon].ios}
        modifiers={[mods.buttonStyle("glass"), mods.buttonBorderShape("circle"), mods.controlSize("large"), mods.menuIndicator("hidden")]}
      >
        {items.map((it) => (
          <ui.Button
            key={it.title}
            label={it.title}
            systemImage={it.icon ? ICONS[it.icon].ios : undefined}
            role={it.destructive ? "destructive" : "default"}
            onPress={it.onPress}
            modifiers={it.disabled ? [mods.disabled(true)] : undefined}
          />
        ))}
      </ui.Menu>
    </ui.Host>
  );
}

function FallbackMenu({ items, icon = "more", accessibilityLabel, size = 36 }: Props) {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tap onPress={() => setOpen(true)} accessibilityLabel={accessibilityLabel} haptic="light" hitSlop={6}>
        <Glass interactive radius={size / 2} style={[styles.trigger, { width: size, height: size }]}>
          <Icon name={icon} size={16} color={th.text} weight="semibold" />
        </Glass>
      </Tap>
      <ActionSheet visible={open} onClose={() => setOpen(false)} items={items} />
    </>
  );
}

/** Glass action list over a dimmed scrim. Android's answer to a context menu. */
export function ActionSheet({ visible, onClose, items, title }: { visible: boolean; onClose: () => void; items: MenuItem[]; title?: string }) {
  const th = useTheme();
  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="none" statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu">
        <Animated.View entering={FadeIn.duration(120)} exiting={FadeOut.duration(100)} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.3)" }]} />
      </Pressable>
      <Animated.View entering={ZoomIn.springify().damping(18).stiffness(240)} exiting={FadeOut.duration(100)} style={styles.sheet} pointerEvents="box-none">
        <Glass radius={radius.lg}>
          <View>
            {title ? (
              <Txt variant="footnote" tone="secondary" numberOfLines={1} style={styles.sheetTitle}>
                {title}
              </Txt>
            ) : null}
            {items.map((it, i) => (
              <Tap
                key={it.title}
                scale={0.985}
                disabled={it.disabled}
                onPress={() => {
                  onClose();
                  it.onPress();
                }}
              >
                <View style={[styles.item, i < items.length - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.hairline } : null]}>
                  <Txt variant="body" color={it.destructive ? th.failed : undefined} style={{ flex: 1 }}>
                    {it.title}
                  </Txt>
                  {it.icon ? <Icon name={it.icon} size={18} color={it.destructive ? th.failed : th.textSecondary} /> : null}
                </View>
              </Tap>
            ))}
          </View>
        </Glass>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  trigger: { alignItems: "center", justifyContent: "center" },
  sheet: { position: "absolute", left: space.lg, right: space.lg, bottom: 40 },
  sheetTitle: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 4 },
  item: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, minHeight: 50 },
});
