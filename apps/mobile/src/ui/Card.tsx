// Grouped-inset list card on glass: rows with a leading icon, a label, a
// trailing value, hairlines between rows. Settings and the environment
// summary are built from this.

import React from "react";
import { StyleSheet, View } from "react-native";
import { Glass } from "./Glass";
import { Icon, type IconName } from "./Icon";
import { Txt } from "./Screen";
import { Tap } from "./Tap";
import { radius, space, useTheme } from "./theme";

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      {title ? (
        <Txt variant="footnote" tone="secondary" style={styles.title}>
          {title}
        </Txt>
      ) : null}
      <Glass radius={radius.lg}>
        <View>{children}</View>
      </Glass>
    </View>
  );
}

interface RowProps {
  icon?: IconName;
  iconColor?: string;
  label: string;
  value?: string;
  valueColor?: string;
  detail?: string;
  onPress?: () => void;
  destructive?: boolean;
  last?: boolean;
  trailing?: React.ReactNode;
  mono?: boolean;
}

export function Row({ icon, iconColor, label, value, valueColor, detail, onPress, destructive, last, trailing, mono }: RowProps) {
  const th = useTheme();
  const color = destructive ? th.failed : th.text;
  const inner = (
    <View style={[styles.row, !last ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: th.hairline } : null]}>
      {icon ? (
        <View style={styles.icon}>
          <Icon name={icon} size={18} color={iconColor ?? (destructive ? th.failed : th.textSecondary)} />
        </View>
      ) : null}
      <View style={styles.body}>
        <Txt variant="body" color={color} numberOfLines={1}>
          {label}
        </Txt>
        {detail ? (
          <Txt variant="footnote" tone="secondary" numberOfLines={2}>
            {detail}
          </Txt>
        ) : null}
      </View>
      {value ? (
        <Txt variant={mono ? "mono" : "subhead"} color={valueColor} tone="secondary" numberOfLines={1} style={styles.value}>
          {value}
        </Txt>
      ) : null}
      {trailing}
      {onPress && !trailing ? <Icon name="chevronRight" size={13} color={th.textTertiary} weight="semibold" /> : null}
    </View>
  );
  if (!onPress) return inner;
  return (
    <Tap scale={0.985} onPress={onPress} haptic="light">
      {inner}
    </Tap>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6 },
  title: { paddingHorizontal: space.lg, textTransform: "uppercase", letterSpacing: 0.6, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 50, paddingVertical: 10, marginLeft: space.lg, paddingRight: space.lg },
  icon: { width: 24, alignItems: "center" },
  body: { flex: 1, gap: 1 },
  value: { maxWidth: "50%", textAlign: "right" },
});
