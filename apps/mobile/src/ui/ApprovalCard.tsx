// Approval card: the only element in the transcript with a primary button.
// Title repeats the consequence ("Run `rm -rf build`?").

import React, { useEffect, useRef, useState } from "react";
import { Animated, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ApprovalDecision, ApprovalRequest } from "@/protocol";
import { Button } from "./Button";
import { radius, space, type as t, useTheme } from "./theme";

interface Props {
  approval: ApprovalRequest;
  onRespond: (decision: ApprovalDecision) => Promise<void>;
}

export function approvalTitle(a: ApprovalRequest): string {
  const obj = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const n = a.tool_name.toLowerCase();
  if (n === "bash" || n === "shell") {
    const cmd = str("command");
    if (cmd) return `Run \`${cmd.replace(/\s+/g, " ").trim()}\`?`;
  }
  const path = str("file_path") ?? str("path");
  if ((n === "write" || n === "write_file") && path) return `Write ${path}?`;
  if ((n === "edit" || n === "multiedit" || n === "edit_file") && path) return `Edit ${path}?`;
  return `Allow ${a.summary}?`;
}

export function ApprovalCard({ approval, onRespond }: Props) {
  const th = useTheme();
  const [busy, setBusy] = useState<ApprovalDecision["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(4)).current;

  useEffect(() => {
    // 150ms opacity + 4px rise, ease-out (docs/design.md).
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
      Animated.timing(rise, { toValue: 0, duration: 150, useNativeDriver: true }),
    ]).start();
  }, [opacity, rise]);

  const respond = async (d: ApprovalDecision) => {
    setBusy(d.decision);
    setError(null);
    try {
      await onRespond(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the decision. Try again.");
      setBusy(null);
    }
  };

  const detail = detailText(approval);
  return (
    <Animated.View
      accessibilityRole="alert"
      style={[styles.card, { backgroundColor: th.surface, borderColor: th.waiting, opacity, transform: [{ translateY: rise }] }]}
    >
      <Text style={[t.heading, { color: th.text }]}>{approvalTitle(approval)}</Text>
      <Text style={[t.caption, { color: th.textSecondary }]}>{approval.summary}</Text>
      {detail ? (
        <ScrollView horizontal bounces={false} style={[styles.detail, { backgroundColor: th.surfaceRaised }]}>
          <Text style={[t.mono, { color: th.text }]} selectable>
            {detail}
          </Text>
        </ScrollView>
      ) : null}
      {error ? <Text style={[t.caption, { color: th.failed }]}>{error}</Text> : null}
      <View style={styles.actions}>
        <Button title="Allow" variant="primary" busy={busy === "allow_once"} disabled={busy !== null} onPress={() => void respond({ decision: "allow_once" })} />
        <Button title="Always allow" busy={busy === "allow_always"} disabled={busy !== null} onPress={() => void respond({ decision: "allow_always" })} />
        <Button title="Deny" variant="destructive" busy={busy === "deny"} disabled={busy !== null} onPress={() => void respond({ decision: "deny" })} />
      </View>
    </Animated.View>
  );
}

function detailText(a: ApprovalRequest): string | null {
  const obj = (a.input && typeof a.input === "object" ? a.input : null) as Record<string, unknown> | null;
  if (!obj) return null;
  if (typeof obj.command === "string") return null; // already in the title
  if (typeof obj.content === "string") return truncate(obj.content, 1200);
  if (typeof obj.new_string === "string") return truncate(obj.new_string, 1200);
  try {
    return truncate(JSON.stringify(obj, null, 2), 1200);
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.sm },
  detail: { borderRadius: radius.sm, padding: space.sm, maxHeight: 180 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.xs },
});
