import React, { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { Button } from "./Button";
import { radius, space, type as t, useTheme } from "./theme";

interface Props {
  placeholder?: string;
  disabled?: boolean;
  /** Resolve to clear the input; reject to keep the draft. */
  onSend: (text: string) => Promise<void>;
  /** Shown instead of Send while the agent is working. */
  onInterrupt?: () => Promise<void>;
  working?: boolean;
  autoFocus?: boolean;
}

export function Composer({ placeholder = "Message", disabled, onSend, onInterrupt, working, autoFocus }: Props) {
  const th = useTheme();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const canSend = text.trim().length > 0 && !disabled && !busy;

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
    <View style={[styles.row, { borderTopColor: th.border, backgroundColor: th.canvas }]}>
      <TextInput
        accessibilityLabel="Message"
        style={[styles.input, t.body, { color: th.text, backgroundColor: th.surface }]}
        placeholder={placeholder}
        placeholderTextColor={th.textTertiary}
        value={text}
        onChangeText={setText}
        multiline
        autoFocus={autoFocus}
        editable={!disabled}
        blurOnSubmit={false}
      />
      {working && onInterrupt ? (
        <Button title="Stop" onPress={() => void onInterrupt()} />
      ) : (
        <Button title="Send" variant="primary" onPress={() => void send()} disabled={!canSend} busy={busy} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
});
