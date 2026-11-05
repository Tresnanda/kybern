// A failure, in plain words, in the three places one shows up (the phone's counterpart of GPUIX `kit/Problem.tsx`):
//   `ProblemState`  the page or pane that couldn't load: a tone-tinted icon, the headline, one sentence, the fix, then details.
//   `ProblemRow`    a failure inside a section (an `InsetGroup`): the same words in a row, no card of its own.
//   `ErrorBanner`   a failure above or below content, in a tinted card. Takes a `ProblemModel` or, for text that is already
//                   plain, a string. `showProblemToast()` is a command or background job that failed; never a toast for a page
//                   that failed to load.
// Each carries the technical text behind "Show details" with a copy button, never as the headline. The words and the buttons the
// phone can run come from `state/problems.ts`; these components only draw. A fix that runs on the computer is words, not a button.
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { DURATION } from "../components/liquid/motion";
import { problemText, type ProblemModel, type ProblemTone } from "../state/problems";
import { haptics } from "./haptics";
import { Button, Icon, IconButton, T, Tap } from "./primitives";
import { radius, space, useTheme, type Colors } from "./theme";
import { showToast } from "./Toast";

/** What a screen holds for an error: plain text that is already safe to show, or the model with its fix and details. */
export type ErrorValue = ProblemModel | string | null | undefined;

/** A tone's glyph colour and its soft fill. */
function toneColors(colors: Colors, tone: ProblemTone) {
  switch (tone) {
    case "info": return { ink: colors.accent, soft: colors.accentSoft };
    case "warning": return { ink: colors.warning, soft: colors.warningSoft };
    case "danger": return { ink: colors.negative, soft: colors.negativeSoft };
    default: return { ink: colors.secondary, soft: colors.raised };
  }
}

interface Fix {
  label: string;
  onPress: () => void;
}

/** The buttons the model names that this screen can run: retry needs an `onRetry`, Machines is always there. */
function useFixes(problem: ProblemModel, onRetry?: () => void): Fix[] {
  const router = useRouter();
  const fixes: Fix[] = [];
  for (const action of problem.actions) {
    if (action.id === "retry" && onRetry) fixes.push({ label: action.label, onPress: onRetry });
    else if (action.id === "open_machines") fixes.push({ label: action.label, onPress: () => router.push("/machines") });
  }
  return fixes.slice(0, 2);
}

/** "Show details", and once open the technical text with its copy button. Closed by default; the text can be selected. */
function Details({ text }: { text: string }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!text) return null;
  const copy = () => {
    void Clipboard.setStringAsync(text).then(() => {
      haptics.select();
      setCopied(true);
    }, () => {});
  };
  return (
    <View style={{ gap: space.sm, alignSelf: "stretch" }}>
      <Tap
        label={open ? "Hide details" : "Show details"}
        expanded={open}
        feedback="highlight"
        onPress={() => setOpen((value) => !value)}
        style={{ alignSelf: "center", flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.md, borderRadius: radius.full }}
      >
        <T variant="footnote" tone="secondary">
          {open ? "Hide details" : "Show details"}
        </T>
        <Icon name={open ? "chevron.up" : "chevron.down"} size={11} color={colors.secondary} />
      </Tap>
      {open && (
        <View style={{ backgroundColor: colors.code, borderRadius: radius.sm, paddingVertical: space.md, paddingStart: space.md, paddingEnd: 48, minHeight: 48 }}>
          <T variant="mono" tone="secondary" selectable>
            {text}
          </T>
          <View style={{ position: "absolute", top: 0, end: 0 }}>
            <IconButton name={copied ? "checkmark" : "doc.on.doc"} label={copied ? "Copied" : "Copy details"} onPress={copy} size={18} color={colors.secondary} />
          </View>
        </View>
      )}
    </View>
  );
}

/** The fix as the primary button and an optional second one. */
function Fixes({ fixes, size, center }: { fixes: Fix[]; size: "medium" | "small"; center?: boolean }) {
  if (!fixes.length) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: center ? "center" : "flex-start", gap: space.sm }}>
      {fixes.map((fix, index) => (
        <Button key={fix.label} role={index === 0 ? "tinted" : "plain"} size={size} onPress={fix.onPress}>
          {fix.label}
        </Button>
      ))}
    </View>
  );
}

/** A page or pane that couldn't load or run. Fills its parent and centres the words. */
export function ProblemState({ problem, onRetry }: { problem: ProblemModel; onRetry?: () => void }) {
  const { colors } = useTheme();
  const tone = toneColors(colors, problem.tone);
  const fixes = useFixes(problem, onRetry);
  return (
    <View style={{ flexGrow: 1, minHeight: 280, justifyContent: "center" }} accessibilityRole="alert">
      <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space["3xl"], paddingHorizontal: space.xl }}>
        <View style={{ width: 56, height: 56, borderRadius: radius.lg, alignItems: "center", justifyContent: "center", backgroundColor: tone.soft, marginBottom: space.sm }}>
          <Icon name={problem.icon} size={26} color={tone.ink} />
        </View>
        <T variant="headline" accessibilityRole="header" style={{ textAlign: "center" }}>
          {problem.title}
        </T>
        <T variant="subhead" tone="secondary" style={{ textAlign: "center", maxWidth: 320 }}>
          {problem.body}
        </T>
        {fixes.length > 0 && (
          <View style={{ marginTop: space.md }}>
            <Fixes fixes={fixes} size="medium" center />
          </View>
        )}
        <Details text={problem.detail} />
      </View>
    </View>
  );
}

/** A failure inside a section: the glyph, the headline and one sentence, then the fix, in the section's own padding. */
export function ProblemRow({ problem, onRetry }: { problem: ProblemModel; onRetry?: () => void }) {
  const { colors } = useTheme();
  const tone = toneColors(colors, problem.tone);
  const fixes = useFixes(problem, onRetry);
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", alignItems: "flex-start", gap: 14, paddingVertical: 12 }}>
      <View style={{ paddingTop: 1 }}>
        <Icon name={problem.icon} size={20} color={tone.ink} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <T variant="label">{problem.title}</T>
        <T variant="footnote" tone="secondary">
          {problem.body}
        </T>
        <Fixes fixes={fixes} size="small" />
        <View style={{ alignItems: "flex-start" }}>
          <Details text={problem.detail} />
        </View>
      </View>
    </View>
  );
}

/**
 * A failure that blocks the screen's purpose. Says what to do next and offers the fix. A string is text that is already
 * plain; with `onRetry` it gets Try again. A `ProblemModel` also gets its second button and Show details.
 */
export function ErrorBanner({ error, onRetry }: { error?: ErrorValue; onRetry?: () => void }) {
  if (!error) return null;
  return typeof error === "string" ? <PlainBanner text={error} onRetry={onRetry} /> : <ModelBanner problem={error} onRetry={onRetry} />;
}

const bannerStyle = (soft: string) => ({
  flexDirection: "row" as const,
  alignItems: "flex-start" as const,
  gap: 10,
  paddingVertical: space.md,
  paddingHorizontal: 14,
  marginVertical: space.sm,
  borderRadius: radius.md,
  backgroundColor: soft,
});

function PlainBanner({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { colors } = useTheme();
  return (
    <Animated.View entering={FadeIn.duration(DURATION.enter)} exiting={FadeOut.duration(DURATION.exit)} accessibilityLiveRegion="polite" accessibilityRole="alert" style={bannerStyle(colors.negativeSoft)}>
      <View style={{ paddingTop: 1 }}>
        <Icon name="exclamationmark.triangle" size={18} color={colors.negative} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <T variant="subhead" tone="negative">
          {text}
        </T>
        {onRetry && <Fixes fixes={[{ label: "Try again", onPress: onRetry }]} size="medium" />}
      </View>
    </Animated.View>
  );
}

function ModelBanner({ problem, onRetry }: { problem: ProblemModel; onRetry?: () => void }) {
  const { colors } = useTheme();
  const tone = toneColors(colors, problem.tone);
  const fixes = useFixes(problem, onRetry);
  return (
    <Animated.View entering={FadeIn.duration(DURATION.enter)} exiting={FadeOut.duration(DURATION.exit)} accessibilityLiveRegion="polite" accessibilityRole="alert" style={bannerStyle(tone.soft)}>
      <View style={{ paddingTop: 1 }}>
        <Icon name={problem.icon} size={18} color={tone.ink} />
      </View>
      <View style={{ flex: 1, gap: space.xs }}>
        <T variant="subhead" style={{ fontWeight: "600" }}>
          {problem.title}
        </T>
        <T variant="footnote" tone="secondary">
          {problem.body}
        </T>
        <Fixes fixes={fixes} size="medium" />
        <View style={{ alignItems: "flex-start" }}>
          <Details text={problem.detail} />
        </View>
      </View>
    </Animated.View>
  );
}

/**
 * A command or background job that failed: the words as a toast, with Try again when the caller can, else Copy details. Never for a
 * page that failed to load; that is a `ProblemState`.
 */
export function showProblemToast(problem: ProblemModel, retry?: () => void) {
  const action = retry
    ? { title: "Try again", icon: "arrow.clockwise" as const, onPress: retry }
    : problem.detail
      ? { title: "Copy details", icon: "doc.on.doc" as const, onPress: () => void Clipboard.setStringAsync(problem.detail).catch(() => {}) }
      : undefined;
  haptics.error();
  showToast(problemText(problem), action, 6000);
}
