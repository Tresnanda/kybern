// An agent's inline visual (`kybern_html_publish`). At rest it is the daemon's picture of the page
// (`threads.visuals.snapshot`, drawn in this app's theme at the column width), so scrolling past it
// costs an image. A tap opens the live page in place: a WebView on a one-time frame ticket
// (`threads.visuals.frame`), served with the daemon's sandbox policy; no credentials enter the page.
// A visual that asks (`await_answer`) gets the answer bar: the page drafts a value, the reader sends
// it or skips. The receipt line stays under an answered visual.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { httpBase } from "../../../../packages/kybern-client/src/address";
import {
  visualFrameHeight,
  visualHeight,
  visualLink,
  visualThemeFragment,
  type VisualTheme,
} from "../../../../packages/kybern-client/src/visuals";
import {
  ANSWER_COPY,
  answerAction,
  answerHint,
  answerKind,
  answerReceipt,
  answerTitle,
  draftLabel,
  visualAnswerInput,
} from "../../../../packages/kybern-client/src/visualAnswer";
import type { ApprovalRequest, HtmlSnapshotResult, JsonValue } from "../state/protocol";
import { activeEnvironment, errorText, rpc, useThreadValue } from "../state/runtime";
import type { Block, ThreadState } from "../state/transcript";
import { haptics } from "../ui/haptics";
import { Button, ErrorBanner, Icon, T, Tap } from "../ui/primitives";
import { MONO, radius, space, useTheme, type Colors } from "../ui/theme";
import { agentFor, respondApproval } from "./RequestCards";
import { AuthedImage } from "../ui/AuthedImage";

type VisualBlock = Extract<Block, { kind: "visual" }>;

/** The page's CSS variables in this app's palette, as the daemon's own default theme names them. */
function visualTheme(colors: Colors, dark: boolean): VisualTheme {
  const charts = dark
    ? ["#339cff", "#2dd4bf", "#fbbf24", "#c084fc", "#fb7185", "#a3e635"]
    : ["#0169cc", "#0d9488", "#d97706", "#9333ea", "#e11d48", "#65a30d"];
  return {
    appearance: dark ? "dark" : "light",
    variables: {
      "--background": "transparent",
      "--foreground": colors.ink,
      "--muted-foreground": colors.secondary,
      "--border": colors.line,
      "--card": colors.card,
      "--primary": colors.accent,
      "--accent": colors.accent,
      ...Object.fromEntries(charts.map((color, i) => [`--chart-${i + 1}`, color])),
      "--font-sans": "-apple-system, system-ui, Roboto, sans-serif",
      "--font-mono": `${MONO}, ui-monospace, Menlo, monospace`,
    },
  };
}

// Pictures already drawn this session, by visual, width and appearance: a remount never asks again.
const pictures = new Map<string, HtmlSnapshotResult>();

/** Forward the page's posts to the app: in a WebView the page is the top window, so `parent` is ours. */
const BRIDGE = `(function(){try{var post=function(d){try{window.ReactNativeWebView.postMessage(JSON.stringify(d))}catch(_){}};window.parent={postMessage:post};}catch(_){}})();true;`;

function useVisualAnswerApproval(threadId: string, visualId: string) {
  const select = useCallback(
    (snapshot: ThreadState) =>
      snapshot.pendingApprovals.find((approval) => visualAnswerInput(approval)?.visual_id === visualId) ?? null,
    [visualId],
  );
  return useThreadValue(threadId, select);
}

export const InlineVisual = memo(function InlineVisual({ block, threadId }: { block: VisualBlock; threadId: string }) {
  const { colors, dark } = useTheme();
  const environment = activeEnvironment();
  const [width, setWidth] = useState(0);
  const [picture, setPicture] = useState<HtmlSnapshotResult | null>(null);
  const [pictureFailed, setPictureFailed] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [liveHeight, setLiveHeight] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<{ value: JsonValue; label: string } | null>(null);
  const approval = useVisualAnswerApproval(threadId, block.id);
  const theme = useMemo(() => visualTheme(colors, dark), [colors, dark]);
  const lock = block.answer ? { state: block.answer.status, answer: block.answer.answer ?? null } : null;
  const key = `${threadId}:${block.id}:${Math.round(width)}:${theme.appearance}:${block.answer?.status ?? ""}`;

  useEffect(() => {
    if (!width || live) return;
    const known = pictures.get(key);
    if (known) {
      setPicture(known);
      return;
    }
    let alive = true;
    setPictureFailed(false);
    rpc("threads.visuals.snapshot", {
      thread_id: threadId,
      visual_id: block.id,
      width: Math.round(width),
      theme: theme as unknown as JsonValue,
      ...(lock ? { lock: lock as unknown as JsonValue } : {}),
    })
      .then((result) => {
        pictures.set(key, result);
        if (pictures.size > 48) pictures.delete(pictures.keys().next().value!);
        if (alive) setPicture(result);
      })
      .catch(() => {
        if (alive) setPictureFailed(true);
      });
    return () => {
      alive = false;
    };
    // `lock` follows `block.answer`, which is part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width, live, threadId, block.id, theme]);

  const open = async () => {
    if (!environment || opening) return;
    setOpening(true);
    setError("");
    try {
      const { ticket } = await rpc("threads.visuals.frame", { thread_id: threadId, visual_id: block.id });
      const fragment = `${visualThemeFragment(theme)}${lock ? `&kybern-lock=${encodeURIComponent(JSON.stringify(lock))}` : ""}`;
      setLive(`${httpBase(environment.url)}/visual-frame/${encodeURIComponent(ticket)}${fragment}`);
    } catch (e) {
      setError(errorText(e) || "Unable to open the visual. Check the connection and try again.");
    } finally {
      setOpening(false);
    }
  };

  const onMessage = (event: WebViewMessageEvent) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (data.kind === "kybern-visual-size") {
      const next = visualHeight(data.height);
      if (next) setLiveHeight(next);
    } else if (data.kind === "kybern-visual-draft") {
      if (data.value === null || data.value === undefined) setDraft(null);
      else {
        setDraft({ value: data.value as JsonValue, label: draftLabel(data.value as JsonValue, typeof data.label === "string" ? data.label : null) });
        haptics.select();
      }
    } else if (data.kind === "kybern-visual-link") {
      const url = visualLink(data.url);
      if (url) void Linking.openURL(url).catch(() => {});
    }
  };

  const restHeight = picture ? (picture.clamped ? picture.clamp : picture.height) : width ? visualFrameHeight(block.visual, width) : 160;
  const frameHeight = liveHeight ?? (width ? visualFrameHeight(block.visual, width) : 160);
  const pictureUri =
    picture && environment
      ? `${httpBase(environment.url)}/threads/${encodeURIComponent(threadId)}/visuals/${encodeURIComponent(block.id)}/snapshot/${picture.key}${picture.clamped ? "-fade" : ""}.png`
      : null;
  return (
    <View style={{ gap: space.sm }}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{
          borderRadius: radius.md,
          borderCurve: "continuous",
          overflow: "hidden",
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
          backgroundColor: colors.card,
        }}
      >
        {live ? (
          <WebView
            source={{ uri: live }}
            originWhitelist={["*"]}
            injectedJavaScriptBeforeContentLoaded={BRIDGE}
            onMessage={onMessage}
            javaScriptEnabled
            domStorageEnabled={false}
            incognito
            allowsLinkPreview={false}
            setSupportMultipleWindows={false}
            scrollEnabled={false}
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            onShouldStartLoadWithRequest={(request) => {
              if (request.url.startsWith(live.split("#")[0]!) || request.url === "about:blank") return true;
              const url = visualLink(request.url);
              if (url) void Linking.openURL(url).catch(() => {});
              return false;
            }}
            style={{ height: frameHeight, backgroundColor: "transparent" }}
            containerStyle={{ backgroundColor: "transparent" }}
          />
        ) : (
          <Tap
            label={`${block.visual.title}. Open the live visual`}
            hint={approval ? "Open it to choose" : undefined}
            onPress={() => void open()}
            feedback="none"
            disabled={!environment}
            style={{ height: restHeight }}
          >
            {pictureUri ? (
              <AuthedImage
                source={{ uri: pictureUri, headers: { authorization: `Bearer ${environment?.token ?? ""}` } }}
                accessibilityIgnoresInvertColors
                fadeDuration={0}
                resizeMode="cover"
                style={{ width: "100%", height: restHeight }}
              />
            ) : (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg }}>
                <Icon name="viewfinder" size={22} color={colors.secondary} />
                <T variant="footnote" tone="secondary" style={{ textAlign: "center" }}>
                  {pictureFailed ? "Tap to open the visual" : "Loading the visual…"}
                </T>
              </View>
            )}
          </Tap>
        )}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <T variant="footnote" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
          {block.visual.title}
        </T>
        {live ? (
          <Tap label="Close the live visual" onPress={() => { setLive(null); setLiveHeight(null); }} style={{ alignItems: "center", justifyContent: "center" }}>
            <T variant="footnote" tone="accent">
              Done
            </T>
          </Tap>
        ) : (
          <Tap label="Open the live visual" onPress={() => void open()} disabled={!environment || opening} style={{ alignItems: "center", justifyContent: "center" }}>
            <T variant="footnote" tone="accent">
              {opening ? "Opening…" : "Open"}
            </T>
          </Tap>
        )}
      </View>
      <ErrorBanner error={error} />
      {approval && <AnswerBar approval={approval} draft={draft} live={!!live} onOpen={() => void open()} />}
      {block.answer && <Receipt block={block} threadId={threadId} />}
    </View>
  );
});

function Receipt({ block, threadId }: { block: VisualBlock; threadId: string }) {
  const { colors } = useTheme();
  const kind = answerKind(block.visual.ask?.schema ?? null);
  const done = block.answer!.status === "answered" || block.answer!.status === "replied";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 28 }}>
      <Icon name={done ? "checkmark.circle" : "clock"} size={14} color={done ? colors.positive : colors.muted} />
      <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
        {answerReceipt(block.answer!, kind, agentFor(threadId))}
      </T>
    </View>
  );
}

/** "Claude is waiting for your choice": the drafted value, then Skip and Send it. */
function AnswerBar({
  approval,
  draft,
  live,
  onOpen,
}: {
  approval: ApprovalRequest;
  draft: { value: JsonValue; label: string } | null;
  live: boolean;
  onOpen: () => void;
}) {
  const input = visualAnswerInput(approval)!;
  const kind = answerKind(input.schema ?? null);
  const [busy, setBusy] = useState<"" | "send" | "skip">("");
  const [error, setError] = useState("");
  const agent = agentFor(approval.thread_id);
  const sent = useRef(false);
  const respond = async (skip: boolean) => {
    if (sent.current) return;
    setBusy(skip ? "skip" : "send");
    setError("");
    try {
      sent.current = true;
      await respondApproval(
        approval,
        skip ? { decision: "deny" } : { decision: "submit", response: { answer: draft!.value, label: draft!.label } },
      );
      if (!skip) haptics.success();
    } catch (e) {
      sent.current = false;
      setError(errorText(e) || ANSWER_COPY.sendError);
      setBusy("");
    }
  };
  return (
    <View style={{ gap: space.sm }} accessibilityLiveRegion="polite">
      <T variant="subhead">{answerTitle(kind, agent)}</T>
      <T variant="footnote" tone="secondary">
        {live ? answerHint(kind, draft?.label ?? null).replace(" Press ↵ to send it.", "") : "Open the visual to choose."}
      </T>
      <ErrorBanner error={error} />
      <View style={{ flexDirection: "row", gap: space.sm }}>
        <View style={{ flex: 1 }}>
          <Button disabled={!!busy} busy={busy === "skip"} onPress={() => void respond(true)}>
            {ANSWER_COPY.skip}
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          {live ? (
            <Button role="prominent" busy={busy === "send"} disabled={!draft || !!busy} onPress={() => void respond(false)}>
              {answerAction(kind, draft?.label ?? null)}
            </Button>
          ) : (
            <Button role="prominent" onPress={onOpen}>
              Open to choose
            </Button>
          )}
        </View>
      </View>
    </View>
  );
}
