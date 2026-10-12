// The Coordinator's cards on the phone, in the approval surface above the composer:
// the brief proposal (editable text), the settings proposal (old → new rows to untick),
// and git approvals (push, push and open a pull request, merge one). Also the quiet
// lines they leave, and Kybern's own "Setup started" row. Words come from
// `packages/kybern-client/src/coordinatorCards.ts`, shared with desktop.
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Platform, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  COORDINATOR_CARD_COPY,
  cardPartsText,
  checksLabel,
  coordinatorCardOutcome,
  gitCardCopy,
  mergeMethodLabel,
  type CardTextPart,
} from "../../../../packages/kybern-client/src/coordinatorCards";
import { settingValueLabel } from "../../../../packages/kybern-client/src/coordinatorSettings";
import type { ApprovalDecision, ApprovalRequest, BriefProposalInput, LeadGitCardInput, SettingsProposalInput } from "../state/protocol";
import { errorText, loadThread, refresh, rpc, useApp } from "../state/runtime";
import { Button, ErrorBanner, Icon, T, Tap, styles, type IconName } from "../ui/primitives";
import { type as typography, useTheme } from "../ui/theme";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** Text with branch names set as code. */
function CardText({ parts, tone = "secondary", variant = "caption" }: { parts: readonly CardTextPart[]; tone?: "secondary" | "ink"; variant?: "caption" | "label" }) {
  const { colors } = useTheme();
  return (
    <T variant={variant} tone={tone}>
      {parts.map((part, index) =>
        part.code ? (
          <Text key={index} style={{ fontFamily: MONO, fontSize: 12, color: colors.ink, backgroundColor: colors.raised }}>
            {` ${part.text} `}
          </Text>
        ) : (
          part.text
        ),
      )}
    </T>
  );
}

function useRespond(approval: ApprovalRequest) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function respond(decision: ApprovalDecision) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await rpc("approvals.respond", { approval_id: approval.id, ...decision });
      await Promise.all([refresh(), loadThread(approval.thread_id)]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(e instanceof Error && "code" in e ? errorText(e) : COORDINATOR_CARD_COPY.answerFailed);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, respond };
}

function CardShell({ icon, title, detail, children }: { icon: IconName; title: React.ReactNode; detail?: React.ReactNode; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={{ padding: 16, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 12 }}
    >
      <View style={[styles.line, { alignItems: "flex-start", gap: 12 }]}>
        <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={17} color={colors.secondary} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          {title}
          {detail}
        </View>
      </View>
      {children}
    </Animated.View>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 10 }}>{children}</View>;
}

export function BriefProposalCard({ approval, input }: { approval: ApprovalRequest; input: BriefProposalInput }) {
  const { colors } = useTheme();
  const [text, setText] = useState(input.text);
  const { busy, error, respond } = useRespond(approval);
  const empty = !text.trim();
  return (
    <CardShell
      icon="pencil"
      title={<T variant="label" style={{ fontWeight: "600" }}>{input.replaces ? COORDINATOR_CARD_COPY.briefReplaceTitle : COORDINATOR_CARD_COPY.briefTitle}</T>}
      detail={<T variant="caption" tone="secondary">{COORDINATOR_CARD_COPY.briefDetail}</T>}
    >
      <TextInput
        underlineColorAndroid="transparent"
        accessibilityLabel="Project brief"
        multiline
        value={text}
        onChangeText={setText}
        editable={!busy}
        scrollEnabled
        textAlignVertical="top"
        selectionColor={colors.accent}
        style={[typography.body, { color: colors.ink, backgroundColor: colors.raised, borderRadius: 14, padding: 12, minHeight: 120, maxHeight: 260, fontSize: 16 }]}
      />
      {empty && <T variant="caption" tone="secondary">{COORDINATOR_CARD_COPY.briefEmpty}</T>}
      <ErrorBanner error={error} />
      <Actions>
        <View style={{ flex: 1 }}>
          <Button secondary disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button busy={busy} disabled={empty} onPress={() => void respond({ decision: "submit", response: { text } })}>{COORDINATOR_CARD_COPY.briefSave}</Button>
        </View>
      </Actions>
      <T variant="caption" tone="muted" style={{ textAlign: "center" }}>{COORDINATOR_CARD_COPY.briefFootnote}</T>
    </CardShell>
  );
}

export function SettingsProposalCard({ approval, input }: { approval: ApprovalRequest; input: SettingsProposalInput }) {
  const { colors } = useTheme();
  const app = useApp();
  const [accepted, setAccepted] = useState(() => new Set(input.changes.map((change) => change.path)));
  const { busy, error, respond } = useRespond(approval);
  const toggle = (path: string) =>
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <CardShell
      icon="gearshape"
      title={<T variant="label" style={{ fontWeight: "600" }}>{COORDINATOR_CARD_COPY.settingsTitle}</T>}
      detail={
        <>
          {!!input.reason && <T variant="caption" tone="secondary">{input.reason}</T>}
          <T variant="caption" tone="secondary">{COORDINATOR_CARD_COPY.settingsDetail}</T>
        </>
      }
    >
      <View style={{ borderRadius: 14, borderWidth: 1, borderColor: colors.line, overflow: "hidden" }}>
        {input.changes.map((change, index) => {
          const on = accepted.has(change.path);
          const oldText = settingValueLabel(change.path, change.old, app.providers);
          const newText = settingValueLabel(change.path, change.new, app.providers);
          return (
            <Tap
              key={change.path}
              static
              label={`${change.label}: ${oldText} to ${newText}`}
              selected={on}
              disabled={busy}
              onPress={() => toggle(change.path)}
              style={[styles.line, { alignItems: "flex-start", paddingHorizontal: 12, paddingVertical: 10, gap: 10, borderTopWidth: index ? 1 : 0, borderColor: colors.line }]}
            >
              <Icon name={on ? "checkmark.square.fill" : "square"} size={18} color={on ? colors.ink : colors.muted} />
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="caption" tone="secondary">{change.label}</T>
                <T variant="caption" tone={on ? "ink" : "secondary"}>
                  <Text style={{ textDecorationLine: "line-through", color: colors.muted }}>{oldText}</Text>
                  {"  →  "}
                  {newText}
                </T>
              </View>
            </Tap>
          );
        })}
      </View>
      <ErrorBanner error={error} />
      <Actions>
        <View style={{ flex: 1 }}>
          <Button secondary disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button
            busy={busy}
            disabled={accepted.size === 0}
            onPress={() => void respond({ decision: "submit", response: { accepted: input.changes.map((change) => change.path).filter((path) => accepted.has(path)) } })}
          >
            {`Apply ${accepted.size} ${accepted.size === 1 ? "change" : "changes"}`}
          </Button>
        </View>
      </Actions>
    </CardShell>
  );
}

export function GitApprovalCard({ approval, input }: { approval: ApprovalRequest; input: LeadGitCardInput }) {
  const { colors } = useTheme();
  const { busy, error, respond } = useRespond(approval);
  const copy = gitCardCopy(input);
  const merge = input.op === "merge_pr";
  const checks = merge ? checksLabel(input.checks) : null;
  return (
    <CardShell
      icon={input.op === "merge_pr" ? "arrow.triangle.pull" : "arrow.up"}
      title={<CardText parts={copy.title} tone="ink" variant="label" />}
      detail={copy.detail.length ? <CardText parts={copy.detail} /> : undefined}
    >
      {input.op === "open_pr" && (!!input.title || !!input.body) && (
        <View style={{ padding: 12, borderRadius: 14, backgroundColor: colors.raised, gap: 3 }}>
          {!!input.title && <T variant="label">{input.title}</T>}
          {!!input.body && <T variant="caption" tone="secondary" numberOfLines={3}>{input.body}</T>}
        </View>
      )}
      {merge && (
        <View style={[styles.line, { gap: 6, flexWrap: "wrap" }]}>
          {checks && <T variant="caption" tone={checks.tone === "ok" ? "positive" : checks.tone === "bad" ? "negative" : "secondary"}>{checks.text}</T>}
          <T variant="caption" tone="secondary">· {mergeMethodLabel(input.method)}</T>
        </View>
      )}
      <ErrorBanner error={error} />
      <Actions>
        <View style={{ flex: 1 }}>
          <Button secondary disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button busy={busy} danger={merge} onPress={() => void respond({ decision: "allow_once" })}>{copy.action}</Button>
        </View>
      </Actions>
      {merge && <T variant="caption" tone="muted" style={{ textAlign: "center" }}>{COORDINATOR_CARD_COPY.mergeWarning}</T>}
    </CardShell>
  );
}

/** A settled Coordinator card: one quiet line. */
export function CoordinatorCardLine({ parts, decision }: { parts: readonly CardTextPart[]; decision: ApprovalDecision | null }) {
  const { colors } = useTheme();
  const outcome = coordinatorCardOutcome(decision);
  return (
    <View style={[styles.line, { gap: 8, paddingVertical: 8 }]} accessibilityLabel={cardPartsText(parts)}>
      <Icon
        name={outcome === "done" ? "checkmark.circle" : outcome === "pending" ? "circle.dotted" : "exclamationmark.circle"}
        size={14}
        color={outcome === "done" ? colors.positive : outcome === "declined" ? colors.negative : colors.secondary}
      />
      <View style={{ flex: 1 }}>
        <CardText parts={parts} />
      </View>
    </View>
  );
}

/** A row Kybern adds to the conversation ("Setup started"): centered, quiet, hairlines to either side. */
export function SystemRowLine({ text }: { text: string }) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="text" style={[styles.line, { gap: 10, marginVertical: 14 }]}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      <T variant="caption" tone="secondary">{text}</T>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}
