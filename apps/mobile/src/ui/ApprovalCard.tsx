// Approval panel: the only element with a primary button on the thread. The
// title repeats the consequence so the buttons answer it without the body.

import React, { useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import type { ApprovalDecision, ApprovalRequest } from "@/protocol";
import { Button } from "./Button";
import { Glass } from "./Glass";
import { Icon } from "./Icon";
import { Txt } from "./Screen";
import { fireHaptic } from "./Tap";
import { radius, space, type as t, useTheme } from "./theme";

interface Props {
  approval: ApprovalRequest;
  onRespond: (decision: ApprovalDecision) => Promise<void>;
  /** Shown above the title on the approvals tab. */
  context?: string;
  onOpen?: () => void;
}

export function approvalTitle(a: ApprovalRequest): string {
  const obj = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof obj[k] === "string" ? (obj[k] as string) : undefined);
  const n = a.tool_name.toLowerCase();
  if (n === "bash" || n === "shell") {
    const cmd = str("command");
    if (cmd) return `Run ${cmd.replace(/\s+/g, " ").trim()}?`;
  }
  const path = str("file_path") ?? str("path");
  if ((n === "write" || n === "write_file") && path) return `Write ${short(path)}?`;
  if ((n === "edit" || n === "multiedit" || n === "edit_file") && path) return `Edit ${short(path)}?`;
  return `Allow ${a.summary}?`;
}

function short(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

export function ApprovalCard({ approval, onRespond, context, onOpen }: Props) {
  const th = useTheme();
  const [busy, setBusy] = useState<ApprovalDecision["decision"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (d: ApprovalDecision) => {
    setBusy(d.decision);
    setError(null);
    try {
      await onRespond(d);
      fireHaptic(d.decision === "deny" ? "light" : "success");
    } catch (e) {
      fireHaptic("error");
      setError(e instanceof Error ? e.message : "Unable to send the decision. Try again.");
      setBusy(null);
    }
  };

  const detail = detailText(approval);
  return (
    <Animated.View entering={FadeInDown.springify().damping(18).stiffness(200)} exiting={FadeOutDown.duration(160)} accessibilityRole="alert">
      <Glass radius={radius.xl} tint={th.dark ? "rgba(230,163,46,0.08)" : "rgba(217,143,12,0.06)"} style={styles.card}>
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: th.waiting }]}>
            <Icon name="shield" size={13} color="#FFFFFF" weight="bold" />
          </View>
          <Txt variant="footnote" tone="secondary" style={styles.flex} numberOfLines={1}>
            {context ?? "Waiting for you"}
          </Txt>
          {onOpen ? (
            <Txt variant="footnote" tone="secondary" onPress={onOpen} suppressHighlighting>
              Open thread
            </Txt>
          ) : null}
        </View>
        <Txt variant="headline" style={{ fontFamily: isCommand(approval) ? t.mono.fontFamily : undefined, fontSize: isCommand(approval) ? 15 : 17 }}>
          {approvalTitle(approval)}
        </Txt>
        {approval.summary && approvalTitle(approval) !== `Allow ${approval.summary}?` ? (
          <Txt variant="footnote" tone="secondary" numberOfLines={2}>
            {approval.summary}
          </Txt>
        ) : null}
        {detail ? (
          <ScrollView horizontal bounces={false} style={[styles.detail, { backgroundColor: th.codeFill }]} contentContainerStyle={{ padding: space.md }}>
            <Txt variant="monoSmall" selectable>
              {detail}
            </Txt>
          </ScrollView>
        ) : null}
        {error ? (
          <Txt variant="footnote" color={th.failed}>
            {error}
          </Txt>
        ) : null}
        <View style={styles.actions}>
          <Button title="Allow" variant="ink" haptic={false} busy={busy === "allow_once"} disabled={busy !== null} onPress={() => void respond({ decision: "allow_once" })} style={styles.flex} />
          <Button title="Always" haptic={false} busy={busy === "allow_always"} disabled={busy !== null} onPress={() => void respond({ decision: "allow_always" })} style={styles.flex} />
          <Button title="Deny" haptic={false} destructive busy={busy === "deny"} disabled={busy !== null} onPress={() => void respond({ decision: "deny" })} style={styles.flex} />
        </View>
      </Glass>
    </Animated.View>
  );
}

function isCommand(a: ApprovalRequest): boolean {
  const n = a.tool_name.toLowerCase();
  const obj = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  return (n === "bash" || n === "shell") && typeof obj.command === "string";
}

function detailText(a: ApprovalRequest): string | null {
  const obj = (a.input && typeof a.input === "object" ? a.input : null) as Record<string, unknown> | null;
  if (!obj) return null;
  if (typeof obj.command === "string") return null;
  if (typeof obj.content === "string") return truncate(obj.content, 800);
  if (typeof obj.new_string === "string") return truncate(obj.new_string, 800);
  try {
    return truncate(JSON.stringify(obj, null, 2), 800);
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const styles = StyleSheet.create({
  card: { padding: space.lg, gap: space.sm },
  header: { flexDirection: "row", alignItems: "center", gap: space.sm },
  badge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
  detail: { borderRadius: radius.md, maxHeight: 160 },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
});
