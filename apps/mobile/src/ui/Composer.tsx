// Floating glass composer. Rides the keyboard on the UI thread; the send circle
// swaps to a stop square while the agent works.

import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Tap } from "./Tap";
import { radius, space, type as t, useTheme } from "./theme";

interface Props {
  placeholder?: string;
  disabled?: boolean;
  /** Resolve to clear the input; reject to keep the draft. */
  onSend: (text: string) => Promise<void>;
  onInterrupt?: () => Promise<void>;
  working?: boolean;
  autoFocus?: boolean;
}

export function Composer({ placeholder = "Message", disabled, onSend, onInterrupt, working, autoFocus }: Props) {
  const th = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const canSend = text.trim().length > 0 && !disabled && !busy;
  const showStop = Boolean(working && onInterrupt);
  const inputRef = useRef<TextInput>(null);

  const send = async () => {
    const draft = text.trim();
    if (!draft) return;
    setBusy(true);
    try {
      await onSend(draft);
      setText("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass interactive radius={radius.xl} style={styles.shell}>
      <View style={styles.row}>
        <TextInput
          ref={inputRef}
          accessibilityLabel="Message"
          style={[styles.input, t.body, { color: th.text }]}
          placeholder={placeholder}
          placeholderTextColor={th.textTertiary}
          value={text}
          onChangeText={setText}
          multiline
          autoFocus={autoFocus}
          editable={!disabled}
          submitBehavior="newline"
          keyboardAppearance={th.dark ? "dark" : "light"}
        />
        <SendCircle stop={showStop} enabled={showStop || canSend} busy={busy} onPress={() => void (showStop ? onInterrupt?.() : send())} />
      </View>
    </Glass>
  );
}

function SendCircle({ stop, enabled, busy, onPress }: { stop: boolean; enabled: boolean; busy: boolean; onPress: () => void }) {
  const th = useTheme();
  const swap = useSharedValue(stop ? 1 : 0);
  const active = useSharedValue(enabled ? 1 : 0);
  useEffect(() => {
    swap.set(withSpring(stop ? 1 : 0, { duration: 260, dampingRatio: 1 }));
  }, [stop, swap]);
  useEffect(() => {
    active.set(withSpring(enabled ? 1 : 0, { duration: 200, dampingRatio: 1 }));
  }, [enabled, active]);

  const sendStyle = useAnimatedStyle(() => ({
    opacity: 1 - swap.get(),
    transform: [{ scale: 1 - swap.get() * 0.5 }],
  }));
  const stopStyle = useAnimatedStyle(() => ({
    opacity: swap.get(),
    transform: [{ scale: 0.5 + swap.get() * 0.5 }],
  }));
  const circle = useAnimatedStyle(() => ({ opacity: 0.35 + active.get() * 0.65 }));

  return (
    <Tap
      onPress={onPress}
      disabled={!enabled || busy}
      haptic={stop ? "medium" : "light"}
      accessibilityLabel={stop ? "Stop" : "Send"}
      hitSlop={8}
    >
      <Animated.View style={[styles.circle, { backgroundColor: stop ? th.failed : th.ink }, circle]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, sendStyle]}>
          <Icon name="send" size={17} color={th.onInk} weight="bold" />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, stopStyle]}>
          <Icon name="stop" size={14} color="#FFFFFF" weight="bold" />
        </Animated.View>
      </Animated.View>
    </Tap>
  );
}

const styles = StyleSheet.create({
  shell: { marginHorizontal: space.md },
  row: { flexDirection: "row", alignItems: "flex-end", paddingLeft: space.lg, paddingRight: 6, paddingVertical: 6, gap: space.sm },
  input: { flex: 1, minHeight: 36, maxHeight: 150, paddingVertical: 7, paddingHorizontal: 0 },
  circle: { width: 36, height: 36, borderRadius: 18 },
  center: { alignItems: "center", justifyContent: "center" },
});
