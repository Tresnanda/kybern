// `kybern_request_secret` on the phone: the card that asks for one secret, and the
// quiet line a settled request leaves in the conversation. The value lives only in
// this card's state until it is sent with the answer; it is never logged or stored,
// and Kybern (not the agent) writes it to the file.
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Text, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  SECRET_REQUEST_COPY,
  secretDestination,
  secretOutcome,
  secretOutcomeLine,
  secretPartsText,
  type SecretTextPart,
} from "../../../../packages/kybern-client/src/secretRequest";
import type { ApprovalDecision, ApprovalRequest, SecretRequestInput } from "../state/protocol";
import { errorText, loadThread, refresh, rpc } from "../state/runtime";
import { Button, ErrorBanner, Icon, T, Tap, styles } from "../ui/primitives";
import { type as typography, useTheme } from "../ui/theme";

const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** Text with the file and key set as code. */
function SecretText({ parts, tone = "secondary" }: { parts: readonly SecretTextPart[]; tone?: "secondary" | "ink" }) {
  const { colors } = useTheme();
  return (
    <T variant="caption" tone={tone}>
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

export function SecretRequestCard({ approval, input }: { approval: ApprovalRequest; input: SecretRequestInput }) {
  const { colors } = useTheme();
  const field = useRef<TextInput>(null);
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function respond(decision: ApprovalDecision) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await rpc("approvals.respond", { approval_id: approval.id, ...decision });
      setValue("");
      await Promise.all([refresh(), loadThread(approval.thread_id)]);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      // The daemon's own words when it refused the answer; otherwise the connection failed.
      setError(e instanceof Error && "code" in e ? errorText(e) : "Unable to send your answer. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  const save = () => {
    if (!value) {
      field.current?.focus();
      return;
    }
    void respond({ decision: "submit", response: { secret: value } });
  };

  return (
    <Animated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      accessibilityLabel={`${input.label}. ${secretPartsText(secretDestination(input))}`}
      style={{ padding: 16, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 12 }}
    >
      <View style={[styles.line, { alignItems: "flex-start", gap: 12 }]}>
        <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center" }}>
          <Icon name="key" size={17} color={colors.secondary} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <T variant="label" style={{ fontWeight: "600" }}>{input.label}</T>
          {!!input.reason && <T variant="caption" tone="secondary">{input.reason}</T>}
          <SecretText parts={secretDestination(input)} />
        </View>
      </View>
      <View style={[styles.line, { gap: 0, minHeight: 48, borderRadius: 14, backgroundColor: colors.raised, paddingStart: 14 }]}>
        <TextInput
          ref={field}
          underlineColorAndroid="transparent"
          accessibilityLabel={`${input.label} value`}
          value={value}
          onChangeText={setValue}
          editable={!busy}
          secureTextEntry={!shown}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={save}
          placeholder={input.placeholder ?? undefined}
          placeholderTextColor={colors.muted}
          selectionColor={colors.accent}
          style={[typography.body, { flex: 1, color: colors.ink, paddingVertical: 10, fontFamily: shown ? MONO : undefined, fontSize: 16 }]}
        />
        <Tap label={shown ? "Hide the value" : "Show the value"} selected={shown} onPress={() => setShown(!shown)} style={{ paddingHorizontal: 14, alignItems: "center" }}>
          <T variant="caption" tone="secondary">{shown ? "Hide" : "Show"}</T>
        </Tap>
      </View>
      <ErrorBanner error={error} />
      <View style={{ flexDirection: "row", gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Button secondary disabled={busy} onPress={() => void respond({ decision: "deny" })}>
            {SECRET_REQUEST_COPY.decline}
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button busy={busy} disabled={!value} onPress={save}>
            {SECRET_REQUEST_COPY.save}
          </Button>
        </View>
      </View>
      <View style={[styles.line, { gap: 6, justifyContent: "center" }]}>
        <Icon name="lock" size={12} color={colors.muted} />
        <T variant="caption" tone="muted" style={{ flexShrink: 1 }}>{SECRET_REQUEST_COPY.footnote}</T>
      </View>
    </Animated.View>
  );
}

/** A settled request: one quiet line, never the value. */
export function SecretRequestLine({ input, decision }: { input: SecretRequestInput; decision: ApprovalDecision | null }) {
  const { colors } = useTheme();
  const saved = secretOutcome(decision) === "saved";
  const parts = secretOutcomeLine(input, decision);
  return (
    <View style={[styles.line, { gap: 8, paddingVertical: 8 }]} accessibilityLabel={secretPartsText(parts)}>
      <Icon name={saved ? "checkmark.circle" : "key"} size={14} color={saved ? colors.positive : colors.secondary} />
      <View style={{ flex: 1 }}>
        <SecretText parts={parts} />
      </View>
    </View>
  );
}
