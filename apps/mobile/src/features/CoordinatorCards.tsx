// The Coordinator's cards on the phone, in the approval surface above the composer:
// the brief proposal (editable text), the settings proposal (old → new rows to untick),
// and git approvals (push, push and open a pull request, merge one). Also the quiet
// lines they leave, and Kybern's own "Setup started" row. Words come from
// `packages/kybern-client/src/coordinatorCards.ts`, shared with desktop.
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
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
import { rotationLabel, type RotationBlock } from "../../../../packages/kybern-client/src/rotation";
import { settingValueLabel } from "../../../../packages/kybern-client/src/coordinatorSettings";
import type { ApprovalDecision, ApprovalRequest, BriefProposalInput, LeadGitCardInput, SettingsProposalInput } from "../state/protocol";
import { errorText, loadThread, refresh, rpc, useApp } from "../state/runtime";
import { Button, ErrorBanner, Icon, T, Tap, styles, type IconName } from "../ui/primitives";
import { MONO, radius, space, type as typography, useTheme } from "../ui/theme";

/** Text with branch names set as code. */
function CardText({ parts, tone = "secondary", variant = "footnote" }: { parts: readonly CardTextPart[]; tone?: "secondary" | "ink"; variant?: "footnote" | "label" }) {
  const { colors } = useTheme();
  return (
    <T variant={variant} tone={tone}>
      {parts.map((part, index) =>
        part.code ? (
          <Text key={index} style={{ fontFamily: MONO, color: colors.ink, backgroundColor: colors.code }}>
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
      style={{ padding: space.lg, borderRadius: radius.lg, borderCurve: "continuous", backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: space.md }}
    >
      <View style={[styles.line, { alignItems: "flex-start", gap: 12 }]}>
        <View style={{ width: 32, height: 32, borderRadius: radius.sm, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center" }}>
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
      detail={<T variant="footnote" tone="secondary">{COORDINATOR_CARD_COPY.briefDetail}</T>}
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
        style={[typography.callout, { color: colors.ink, backgroundColor: colors.raised, borderRadius: radius.md, padding: 12, minHeight: 120, maxHeight: 260, letterSpacing: 0 }]}
      />
      {empty && <T variant="footnote" tone="secondary">{COORDINATOR_CARD_COPY.briefEmpty}</T>}
      <ErrorBanner error={error} />
      <Actions>
        <View style={{ flex: 1 }}>
          <Button disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button role="prominent" busy={busy} disabled={empty} onPress={() => void respond({ decision: "submit", response: { text } })}>{COORDINATOR_CARD_COPY.briefSave}</Button>
        </View>
      </Actions>
      <T variant="footnote" tone="muted" style={{ textAlign: "center" }}>{COORDINATOR_CARD_COPY.briefFootnote}</T>
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
          {!!input.reason && <T variant="footnote" tone="secondary">{input.reason}</T>}
          <T variant="footnote" tone="secondary">{COORDINATOR_CARD_COPY.settingsDetail}</T>
        </>
      }
    >
      <View style={{ borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" }}>
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
                <T variant="footnote" tone="secondary">{change.label}</T>
                <T variant="footnote" tone={on ? "ink" : "secondary"}>
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
          <Button disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button role="prominent"
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
        <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: colors.raised, gap: 3 }}>
          {!!input.title && <T variant="label">{input.title}</T>}
          {!!input.body && <T variant="footnote" tone="secondary" numberOfLines={3}>{input.body}</T>}
        </View>
      )}
      {merge && (
        <View style={[styles.line, { gap: 6, flexWrap: "wrap" }]}>
          {checks && <T variant="footnote" tone={checks.tone === "ok" ? "positive" : checks.tone === "bad" ? "negative" : "secondary"}>{checks.text}</T>}
          <T variant="footnote" tone="secondary">· {mergeMethodLabel(input.method)}</T>
        </View>
      )}
      <ErrorBanner error={error} />
      <Actions>
        <View style={{ flex: 1 }}>
          <Button disabled={busy} onPress={() => void respond({ decision: "deny" })}>{COORDINATOR_CARD_COPY.decline}</Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button busy={busy} role={merge ? "destructive" : "prominent"} onPress={() => void respond({ decision: "allow_once" })}>{copy.action}</Button>
        </View>
      </Actions>
      {merge && <T variant="footnote" tone="muted" style={{ textAlign: "center" }}>{COORDINATOR_CARD_COPY.mergeWarning}</T>}
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

/**
 * A row Kybern adds to the conversation ("Setup started"): centered, quiet, hairlines to either side.
 * With `onPress` the label opens something (a Coordinator's handoff) and ends in a chevron.
 */
export function SystemRowLine({ text, onPress, hint, busy }: { text: string; onPress?: () => void; hint?: string; busy?: boolean }) {
  const { colors } = useTheme();
  const label = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <T variant="footnote" tone={busy ? "muted" : "secondary"}>{text}</T>
      {onPress && <Icon name="chevron.right" size={11} color={colors.muted} />}
    </View>
  );
  return (
    <View accessibilityRole={onPress ? undefined : "text"} accessibilityState={busy ? { busy: true } : undefined} style={[styles.line, { gap: 10, marginVertical: 14 }]}>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
      {onPress ? (
        <Tap label={text} hint={hint} onPress={onPress} hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}>
          {label}
        </Tap>
      ) : (
        label
      )}
      <View style={{ flex: 1, height: 1, backgroundColor: colors.line }} />
    </View>
  );
}

const rotationClock = (date: Date) => date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A Coordinator's context refresh: "Context refreshed · 2:02 PM", opening the handoff once it has settled. */
export function RotationRow({ block, threadId }: { block: RotationBlock; threadId: string }) {
  const text = rotationLabel(block, rotationClock);
  return (
    <SystemRowLine
      text={text}
      busy={block.pending}
      hint={block.pending ? undefined : "Opens the handoff"}
      onPress={
        block.pending
          ? undefined
          : () => router.push({ pathname: "/handoff", params: { threadId, rotationId: block.rotationId } })
      }
    />
  );
}
