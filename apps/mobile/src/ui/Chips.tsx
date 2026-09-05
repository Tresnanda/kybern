// Single-choice chip row. Glass chips, ink fill for the selection, and a
// selection tick haptic on change.

import React from "react";
import { StyleSheet, View } from "react-native";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Txt } from "./Screen";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

export interface ChipOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  disabled?: boolean;
  /** Tint the selected chip (Full access is orange). */
  accent?: string;
}

interface Props<T extends string> {
  options: ChipOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
}

export function Chips<T extends string>({ options, value, onChange }: Props<T>) {
  const th = useTheme();
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {options.map((o) => {
        const selected = o.value === value;
        const fill = selected ? (o.accent ?? th.ink) : undefined;
        const fg = selected ? (o.accent ? "#FFFFFF" : th.onInk) : th.text;
        const body = (
          <View style={styles.content}>
            {o.icon ? <Icon name={o.icon} size={14} color={fg} weight="semibold" /> : null}
            <Txt variant="subhead" color={fg} style={{ fontWeight: "500" }}>
              {o.label}
            </Txt>
          </View>
        );
        return (
          <Tap
            key={o.value}
            haptic="selection"
            disabled={o.disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: o.disabled }}
            onPress={() => {
              if (!selected) onChange(o.value);
            }}
          >
            {selected ? (
              <View style={[styles.fill, { backgroundColor: fill }]}>{body}</View>
            ) : (
              <Glass interactive radius={radius.pill}>
                {body}
              </Glass>
            )}
          </Tap>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  fill: { borderRadius: radius.pill },
  content: { flexDirection: "row", alignItems: "center", gap: 6, height: 36, paddingHorizontal: space.lg },
});
