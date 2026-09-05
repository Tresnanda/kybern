// Labeled text field on glass. 16px+ text so iOS never zooms the page.

import React from "react";
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import { Glass } from "./Glass";
import { Txt } from "./Screen";
import { radius, space, type as t, useTheme } from "./theme";

interface Props extends TextInputProps {
  label: string;
  hint?: string;
  error?: string | null;
  mono?: boolean;
}

export function Field({ label, hint, error, mono, style, ...rest }: Props) {
  const th = useTheme();
  return (
    <View style={styles.wrap}>
      <Txt variant="footnote" tone="secondary" style={styles.label}>
        {label}
      </Txt>
      <Glass radius={radius.md} tint={error ? (th.dark ? "rgba(239,106,91,0.12)" : "rgba(217,74,58,0.08)") : undefined}>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={th.textTertiary}
          keyboardAppearance={th.dark ? "dark" : "light"}
          style={[styles.input, mono ? { ...t.mono, fontSize: 16 } : t.body, { color: th.text }, style]}
          {...rest}
        />
      </Glass>
      {error ? (
        <Txt variant="footnote" color={th.failed}>
          {error}
        </Txt>
      ) : hint ? (
        <Txt variant="footnote" tone="tertiary">
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { paddingHorizontal: 2 },
  input: { minHeight: 48, paddingHorizontal: space.lg, paddingVertical: 12 },
});
