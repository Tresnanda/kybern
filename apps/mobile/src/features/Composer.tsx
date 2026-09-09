import { buildStructuredTextParts } from "../../../../packages/kybern-client/src/composerTokens";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ComposerCamera } from "./ComposerCamera";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Image, Keyboard, ScrollView, TextInput, View } from "react-native";
import {
  clearContext,
  setDraft,
  useContextParts,
  useDraft,
} from "../state/draft";
import {
  httpBase,
  type ContentPart,
  type Thread,
  type UserMessage,
} from "../state/protocol";
import { composerTrigger, replaceComposerTrigger } from "../state/capabilities";
import { ComposerSuggestions } from "./ComposerSuggestions";
import { ComposerControls } from "./ComposerControls";
import {
  activeEnvironment,
  errorText,
  loadThread,
  rpc,
  useThreadValue,
} from "../state/runtime";
import {
  ErrorBanner,
  Icon,
  IconButton,
  styles,
  T,
  Tap,
} from "../ui/primitives";
import { type, useTheme } from "../ui/theme";
import type { ThreadState } from "../state/transcript";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
} from "react-native-reanimated";
import {
  measureSendView,
  useSendTransition,
} from "../components/liquid/SendTransition";
import {
  sendPartKey,
  type SendRect,
  type SendReceipt,
  type SendSource,
} from "../state/sendTransition";
import { imageSource } from "./MessagePart";
import {
  MorphingMenu,
  type MenuOrigin,
} from "../components/liquid/MorphingMenu";

const COMPOSER_REFLOW = LinearTransition.springify()
  .duration(300)
  .dampingRatio(0.8);
const ATTACH_ENTER = FadeIn.duration(140);
const ATTACH_EXIT = FadeOut.duration(120);
const selectCommands = (state: ThreadState) => state.providerCommands;

function contextLabel(part: ContentPart) {
  if (part.type === "mention") return part.display_name || part.name;
  if (part.type === "skill" || part.type === "attachment") return part.name;
  if (part.type === "file_mention") return part.path;
  return "Attachment";
}

export const Composer = memo(function Composer({
  thread,
  onSend,
  onSteer,
  onStop,
  disabled,
  prompt,
  onPromptConsumed,
}: {
  thread?: Thread | null;
  onSend: (message: UserMessage) => Promise<SendReceipt | void>;
  onSteer?: (message: UserMessage) => Promise<SendReceipt | void>;
  onStop?: () => void;
  disabled?: boolean;
  prompt?: string;
  onPromptConsumed?: () => void;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const sendTransition = useSendTransition();
  const inputBounds = useRef<View>(null);
  const attachmentViews = useRef(new Map<string, View>());
  const attachmentUris = useRef(new Map<string, string>());
  const inputContentHeight = useRef(22);
  const sendLock = useRef(false);
  const [departed, setDeparted] = useState(false);
  const modeButton = useRef<View>(null);
  const [modeOrigin, setModeOrigin] = useState<SendRect | null>(null);
  const [modeOpen, setModeOpen] = useState(false);
  const recoil = useSharedValue(1);
  const composerMotion = useAnimatedStyle(() => ({
    transform: [{ scale: recoil.get() }],
  }));
  const addButton = useRef<View>(null);
  const composerBounds = useRef<View>(null);
  const attachmentScroll = useRef<ScrollView>(null);
  const [cameraOrigin, setCameraOrigin] = useState<SendRect | null>(null);
  const [landingAsset, setLandingAsset] = useState<string | null>(null);
  const pendingLanding = useRef<{
    key: string;
    resolve: (rect: SendRect | null) => void;
  } | null>(null);
  const finishCamera = useCallback(() => {
    setCameraOrigin(null);
    setLandingAsset(null);
  }, []);
  useEffect(
    () => () => {
      pendingLanding.current?.resolve(null);
      pendingLanding.current = null;
    },
    [],
  );
  async function openCamera() {
    Keyboard.dismiss();
    const rect = await measureSendView(composerBounds.current);
    if (rect) setCameraOrigin(rect);
  }
  async function landPhoto(uri: string): Promise<SendRect | null> {
    const part = await uploadAttachment({
      uri,
      name: `Photo-${Date.now()}.jpg`,
      mimeType: "image/jpeg",
    });
    attachmentUris.current.set(part.asset_id, uri);
    setLandingAsset(part.asset_id);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingLanding.current = null;
        resolve(null);
      }, 1000);
      pendingLanding.current = {
        key: sendPartKey(part, 0),
        resolve: (rect) => {
          clearTimeout(timer);
          resolve(rect);
        },
      };
      setAttachments((previous) => [...previous, part]);
    });
  }
  function measureLanding() {
    const pending = pendingLanding.current;
    if (!pending) return;
    void measureSendView(attachmentViews.current.get(pending.key) ?? null).then(
      (rect) => {
        if (!rect || pendingLanding.current !== pending) return;
        pendingLanding.current = null;
        pending.resolve(rect);
      },
    );
  }
  const [addOrigin, setAddOrigin] = useState<MenuOrigin | null>(null);
  const afterAddClose = useRef<(() => void) | null>(null);
  const finishAddClose = useCallback(() => {
    setAddOrigin(null);
    const action = afterAddClose.current;
    afterAddClose.current = null;
    action?.();
  }, []);
  function chooseAddAction(action: () => void) {
    if (afterAddClose.current) return;
    afterAddClose.current = action;
    setAdding(false);
  }
  const draft = useDraft();
  const [text, setText] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [dismissed, setDismissed] = useState("");
  const commands = useThreadValue(thread?.id ?? "", selectCommands);
  const trigger = composerTrigger(text, selection);
  const triggerKey = trigger
    ? `${trigger.start}:${trigger.marker}:${trigger.query}`
    : "";
  const [adding, setAdding] = useState(false);
  const [attachments, setAttachments] = useState<ContentPart[]>([]);
  const replaceTrigger = useRef(false);
  const contextParts = useContextParts(thread?.id ?? "new");
  useEffect(() => {
    if (contextParts.length) {
      setAttachments((prev) => [
        ...prev,
        ...contextParts.filter((part) => part.type !== "text"),
      ]);
      const command = contextParts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      if (command || replaceTrigger.current) {
        const replace = replaceTrigger.current;
        setText((previous) => {
          const clean = replace
            ? previous.replace(/(?:^|\s)[$@/][\w.-]*$/, "").trimEnd()
            : previous;
          return command ? (clean ? `${clean}\n${command}` : command) : clean;
        });
        replaceTrigger.current = false;
      }
      clearContext(thread?.id ?? "new");
    }
  }, [contextParts, thread?.id]);
  const [busy, setBusy] = useState(false);
  const [promptMode, setPromptMode] = useState<"queue" | "steer">("queue");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<TextInput>(null);
  const lastPrompt = useRef("");
  useEffect(() => {
    if (prompt && prompt !== lastPrompt.current) {
      lastPrompt.current = prompt;
      setText(prompt);
      input.current?.focus();
    }
  }, [prompt]);
  const running =
    thread?.status === "running" || thread?.status === "awaiting-approval";
  const steering = running && !!onSteer && promptMode === "steer";
  async function send() {
    if (
      sendLock.current ||
      disabled ||
      busy ||
      uploading ||
      (!text.trim() && !attachments.length)
    )
      return;
    sendLock.current = true;
    setBusy(true);
    setDeparted(false);
    setError("");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const sentText = text;
    const sentAttachments = attachments;
    const visualMessage: UserMessage = {
      parts: [
        ...sentAttachments,
        ...(sentText.trim()
          ? [{ type: "text" as const, text: sentText.trim() }]
          : []),
      ],
    };
    const structured = /(?:^|\s)[$@]/.test(sentText);
    let outgoingId: number | undefined;
    try {
      const sources: Record<string, SendSource> = {};
      if (!reduced && !structured) {
        await Promise.all([
          measureSendView(inputBounds.current).then((rect) => {
            if (rect && sentText.trim())
              sources.text = {
                rect: {
                  x: rect.x + 9,
                  y: rect.y + 8,
                  width: rect.width - 18,
                  height: Math.max(
                    22,
                    Math.min(rect.height - 16, inputContentHeight.current),
                  ),
                },
              };
          }),
          ...visualMessage.parts.map(async (part, index) => {
            if (part.type === "text") return;
            const key = sendPartKey(part, index);
            const rect = await measureSendView(
              attachmentViews.current.get(key) ?? null,
            );
            if (rect)
              sources[key] = {
                rect,
                uri:
                  part.type === "attachment"
                    ? attachmentUris.current.get(part.asset_id)
                    : undefined,
              };
          }),
        ]);
      }
      if (!running) {
        outgoingId = sendTransition.begin(
          thread?.id,
          thread?.last_seq ?? 0,
          visualMessage,
          sources,
        );
        // Snapshot first, then clear and dismiss in the same render. The native
        // keyboard drives layout while the outgoing overlay owns the message.
        setDeparted(true);
        setText("");
        setAttachments([]);
        Keyboard.dismiss();
        if (!reduced)
          recoil.set(
            withSequence(
              withSpring(0.985, { duration: 100, dampingRatio: 1 }),
              withSpring(1, { duration: 300, dampingRatio: 0.8 }),
            ),
          );
      }
      const skillItems = structured
        ? (
            await rpc("skills.list", {
              project_id: thread?.project_id ?? draft.projectId,
              provider: thread?.provider.kind ?? draft.provider,
            })
          ).skills
        : [];
      const message: UserMessage = {
        parts: [
          ...sentAttachments,
          ...buildStructuredTextParts(sentText, new Set(), skillItems),
        ],
      };
      const receipt = await (steering ? onSteer! : onSend)(message);
      if (outgoingId !== undefined) {
        if (receipt) sendTransition.confirm(outgoingId, receipt, message);
        else sendTransition.cancel(outgoingId);
      } else {
        if (receipt) sendTransition.start(receipt, message, sources);
        setText("");
        setAttachments([]);
      }
      attachmentUris.current.clear();
      lastPrompt.current = "";
      onPromptConsumed?.();
    } catch (e) {
      if (outgoingId !== undefined) {
        sendTransition.cancel(outgoingId);
        setText(sentText);
        setAttachments(sentAttachments);
        setSelection({ start: sentText.length, end: sentText.length });
      }
      setError(errorText(e));
    } finally {
      sendLock.current = false;
      setDeparted(false);
      setBusy(false);
    }
  }
  async function uploadAttachment(asset: {
    uri: string;
    name: string;
    mimeType?: string;
    size?: number;
  }): Promise<Extract<ContentPart, { type: "attachment" }>> {
    const env = activeEnvironment();
    if (!env)
      throw new Error("Connect your computer, then attach the file again.");
    const file = new File(asset.uri);
    if ((asset.size ?? file.size ?? 0) > 25 * 1024 * 1024)
      throw new Error("Choose a file smaller than 25 MB.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await expoFetch(`${httpBase(env.url)}/assets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.token}`,
          "content-type": asset.mimeType ?? "application/octet-stream",
          "x-kybern-filename": encodeURIComponent(asset.name),
        },
        body: file,
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          "Unable to attach this file. Check your connection and try again.",
        );
      const result = (await response.json()) as {
        id: string;
        name: string;
        media_type: string;
        size: number;
      };
      const current = activeEnvironment();
      if (current?.url !== env.url || current.token !== env.token)
        throw new Error(
          "The connected computer changed. Attach the file again.",
        );
      return {
        type: "attachment",
        asset_id: result.id,
        name: result.name,
        media_type: result.media_type,
        size: result.size,
      };
    } catch (e) {
      if (controller.signal.aborted)
        throw new Error(
          "Upload timed out. Check your connection and try again.",
        );
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  async function attach(photos = false) {
    try {
      const picked = photos
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            allowsMultipleSelection: true,
            quality: 1,
          })
        : await DocumentPicker.getDocumentAsync({
            multiple: true,
            copyToCacheDirectory: true,
          });
      if (picked.canceled) return;
      setUploading(true);
      setError("");
      for (const asset of picked.assets) {
        const part = await uploadAttachment({
          uri: asset.uri,
          name:
            "name" in asset
              ? asset.name
              : (asset.fileName ?? `Photo-${Date.now()}.jpg`),
          mimeType: asset.mimeType,
          size:
            "size" in asset
              ? asset.size
              : "fileSize" in asset
                ? asset.fileSize
                : undefined,
        });
        attachmentUris.current.set(part.asset_id, asset.uri);
        setAttachments((previous) => [...previous, part]);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
    }
  }
  function openCapabilities(category = "Skills", fromTrigger = false) {
    replaceTrigger.current = fromTrigger;
    setAdding(false);
    router.push({
      pathname: "/capabilities",
      params: { ...(thread ? { threadId: thread.id } : {}), category },
    });
  }
  const canCompact =
    !!thread?.provider_session_id &&
    (["codex", "pi", "omp", "opencode"].includes(thread.provider.kind) ||
      commands?.some((c) => c.name === "compact"));
  const actions = [
    { name: "resume", description: "Continue a saved session" },
    { name: "sessions", description: "Browse saved sessions" },
    { name: "attach", description: "Attach files or images" },
    { name: "settings", description: "Open settings" },
    ...(thread
      ? [
          { name: "new", description: "Start a new thread in this project" },
          { name: "activity", description: "Show agents and background tasks" },
          { name: "files", description: "Browse project files" },
          { name: "terminal", description: "Open this thread’s terminal" },
          { name: "changes", description: "Review changes" },
          ...(running
            ? [{ name: "stop", description: "Interrupt the running turn" }]
            : [
                {
                  name: "reconnect",
                  description:
                    "Release the idle agent; resume on your next message",
                },
              ]),
          ...(canCompact && !running
            ? [
                {
                  name: "compact",
                  description: "Compact context and keep the conversation",
                },
              ]
            : []),
        ]
      : []),
  ];
  function runAction(name: string) {
    if (trigger) {
      const next = replaceComposerTrigger(text, trigger);
      setText(next.text);
      setSelection({ start: next.caret, end: next.caret });
    }
    if (name === "attach") {
      void attach();
      return;
    }
    if (name === "settings") {
      router.push("/settings");
      return;
    }
    if (name === "resume" || name === "sessions") {
      router.push("/sessions");
      return;
    }
    if (!thread) return;
    if (name === "new") {
      setDraft({ projectId: thread.project_id });
      router.dismissTo("/");
      return;
    }
    if (name === "activity") {
      router.push({ pathname: "/tasks", params: { threadId: thread.id } });
      return;
    }
    if (name === "stop") {
      onStop?.();
      return;
    }
    if (name === "compact" || name === "reconnect") {
      void rpc(name === "compact" ? "threads.compact" : "threads.release", {
        thread_id: thread.id,
      })
        .then(() => loadThread(thread.id))
        .catch((e) => setError(errorText(e)));
      return;
    }
    router.push({
      pathname: "/workspace",
      params: {
        threadId: thread.id,
        tab:
          name === "files"
            ? "Files"
            : name === "terminal"
              ? "Terminal"
              : "Changes",
      },
    });
  }
  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 8,
        width: "100%",
        maxWidth: 760,
        alignSelf: "center",
        gap: 6,
      }}
    >
      <ErrorBanner error={error} />
      {cameraOrigin && (
        <ComposerCamera
          origin={cameraOrigin}
          onAttach={landPhoto}
          onClosed={finishCamera}
        />
      )}
      {addOrigin && (
        <MorphingMenu
          origin={addOrigin}
          open={adding}
          placement="above"
          preferredWidth={224}
          sourceIcon="plus"
          closingMotion="attachment"
          dismissLabel="Dismiss attachment menu"
          onClose={() => setAdding(false)}
          onClosed={finishAddClose}
        >
          {(
            [
              {
                label: "Camera",
                icon: "camera",
                action: () => {
                  void openCamera();
                },
              },
              {
                label: "Photos",
                icon: "photo",
                action: () => {
                  void attach(true);
                },
              },
              {
                label: "Files",
                icon: "paperclip",
                action: () => {
                  void attach();
                },
              },
              {
                label: "Plugins",
                icon: "puzzlepiece.extension",
                action: () => openCapabilities("Plugins"),
              },
              {
                label: "Project files",
                icon: "folder",
                action: () =>
                  router.push({
                    pathname: "/workspace",
                    params: thread
                      ? { threadId: thread.id, tab: "Files" }
                      : { projectId: draft.projectId, tab: "Files" },
                  }),
              },
            ] as const
          ).map((item) => (
            <Tap
              key={item.label}
              label={item.label}
              onPress={() => chooseAddAction(item.action)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 16,
                minHeight: 48,
                paddingVertical: 10,
                paddingHorizontal: 14,
                borderRadius: 22,
              }}
            >
              <Icon name={item.icon} size={20} />
              <T variant="label" style={{ flexShrink: 1, fontWeight: "400" }}>
                {item.label}
              </T>
            </Tap>
          ))}
        </MorphingMenu>
      )}
      {modeOrigin && (
        <MorphingMenu
          origin={modeOrigin}
          open={modeOpen}
          placement="above"
          sourceIcon="chevron.down"
          dismissLabel="Close send options"
          onClose={() => setModeOpen(false)}
          onClosed={() => setModeOrigin(null)}
        >
          {(onSteer ? (["queue", "steer"] as const) : (["queue"] as const)).map(
            (mode) => (
              <Tap
                key={mode}
                label={mode === "queue" ? "Queue follow-up" : "Steer now"}
                selected={promptMode === mode}
                onPress={() => {
                  setPromptMode(mode);
                  setModeOpen(false);
                }}
                style={[
                  styles.line,
                  {
                    gap: 12,
                    paddingHorizontal: 14,
                    paddingVertical: 10,
                    minHeight: 48,
                  },
                ]}
              >
                <T variant="label" style={{ flex: 1 }}>
                  {mode === "queue" ? "Queue follow-up" : "Steer now"}
                </T>
                {promptMode === mode && <Icon name="checkmark" size={16} />}
              </Tap>
            ),
          )}
          {onStop && (
            <Tap
              label="Stop agent"
              onPress={() => {
                setModeOpen(false);
                onStop();
              }}
              style={[
                styles.line,
                { gap: 12, paddingHorizontal: 14, minHeight: 48 },
              ]}
            >
              <Icon name="stop.fill" size={16} />
              <T variant="label">Stop agent</T>
            </Tap>
          )}
        </MorphingMenu>
      )}
      {trigger && triggerKey !== dismissed && !disabled && (
        <ComposerSuggestions
          trigger={trigger}
          projectId={thread?.project_id ?? draft.projectId}
          provider={thread?.provider.kind ?? draft.provider}
          commands={(commands ?? []).filter(
            (c) => c.name !== "compact" || !canCompact,
          )}
          actions={actions}
          onAction={runAction}
          onDismiss={() => setDismissed(triggerKey)}
          onPick={(part) => {
            const next = replaceComposerTrigger(
              text,
              trigger,
              part.type === "text" ? part.text : "",
            );
            setText(next.text);
            setSelection({ start: next.caret, end: next.caret });
            if (part.type !== "text")
              setAttachments((previous) => [...previous, part]);
            input.current?.focus();
          }}
        />
      )}

      <Animated.View
        ref={composerBounds}
        collapsable={false}
        style={[
          composerMotion,
          {
            borderRadius: 24,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
            padding: 6,
            boxShadow: `0 3px 12px ${colors.backdrop.slice(0, 7)}08`,
          },
        ]}
      >
        {attachments.length > 0 && (
          <View>
            <ScrollView
              ref={attachmentScroll}
              onContentSizeChange={() => {
                if (pendingLanding.current) {
                  attachmentScroll.current?.scrollToEnd({ animated: false });
                  requestAnimationFrame(() =>
                    requestAnimationFrame(measureLanding),
                  );
                }
              }}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, padding: 4 }}
            >
              {attachments.map((part, index) => {
                const key = sendPartKey(part, index);
                const source = imageSource(
                  part,
                  part.type === "attachment"
                    ? attachmentUris.current.get(part.asset_id)
                    : undefined,
                );
                return (
                  <Animated.View
                    key={key}
                    style={{
                      opacity:
                        part.type === "attachment" &&
                        part.asset_id === landingAsset
                          ? 0
                          : 1,
                    }}
                    layout={
                      reduced || landingAsset || busy
                        ? undefined
                        : COMPOSER_REFLOW
                    }
                    entering={landingAsset ? undefined : ATTACH_ENTER}
                    exiting={busy ? undefined : ATTACH_EXIT}
                  >
                    <Tap
                      label={`Remove ${contextLabel(part)}`}
                      disabled={busy}
                      onPress={() => {
                        setAttachments((previous) =>
                          previous.filter((_, i) => i !== index),
                        );
                      }}
                      style={{
                        borderRadius: 16,
                        backgroundColor: colors.raised,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        collapsable={false}
                        ref={(view) => {
                          if (view) attachmentViews.current.set(key, view);
                          else attachmentViews.current.delete(key);
                        }}
                        style={
                          source
                            ? { width: 72, height: 72 }
                            : { ...styles.line, paddingHorizontal: 12 }
                        }
                      >
                        {source ? (
                          <Image
                            source={source}
                            accessibilityLabel={contextLabel(part)}
                            style={{
                              width: 72,
                              height: 72,
                              borderRadius: 16,
                            }}
                            resizeMode="cover"
                          />
                        ) : (
                          <>
                            <Icon
                              name={
                                part.type === "skill"
                                  ? "sparkles"
                                  : part.type === "file_mention"
                                    ? "doc.text"
                                    : "paperclip"
                              }
                              size={14}
                            />
                            <T variant="caption">{contextLabel(part)}</T>
                          </>
                        )}
                      </View>
                      <View
                        pointerEvents="none"
                        style={
                          source
                            ? {
                                position: "absolute",
                                right: 3,
                                top: 3,
                                borderRadius: 12,
                                padding: 5,
                                backgroundColor: colors.surface,
                              }
                            : { position: "absolute", right: 3, top: 3 }
                        }
                      >
                        <Icon name="xmark" size={11} />
                      </View>
                    </Tap>
                  </Animated.View>
                );
              })}
            </ScrollView>
          </View>
        )}

        <View ref={inputBounds} collapsable={false}>
          <TextInput
            underlineColorAndroid="transparent"
            ref={input}
            accessibilityLabel={running ? "Follow-up message" : "Message"}
            placeholder={
              departed && sendTransition.flight
                ? ""
                : steering
                ? "Guide the current turn…"
                : running
                  ? "Ask for follow-up changes…"
                  : "Ask Kybern to build something…"
            }
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={(value) => {
              if (sendLock.current) return;
              setText(value);
              setDismissed("");
            }}
            onSelectionChange={(event) =>
              setSelection(event.nativeEvent.selection)
            }
            onContentSizeChange={(event) => {
              inputContentHeight.current = Math.max(
                22,
                event.nativeEvent.contentSize.height - 16,
              );
            }}
            multiline
            editable={!departed}
            selectionColor={colors.accent}
            style={[
              type.body,
              {
                color: colors.ink,
                minHeight: 44,
                maxHeight: 180,
                paddingHorizontal: 9,
                paddingTop: 8,
                paddingBottom: 8,
              },
            ]}
          />
        </View>
        <ComposerControls
          thread={thread}
          disabled={disabled}
          leading={
            <View ref={addButton} collapsable={false}>
              <IconButton
                name="plus"
                label={adding ? "Close attachment menu" : "Add to message"}
                onPress={() => {
                  if (adding) {
                    setAdding(false);
                    return;
                  }
                  void measureSendView(addButton.current).then((rect) => {
                    if (rect) {
                      setAddOrigin(rect);
                      setAdding(true);
                    }
                  });
                }}
                disabled={disabled || uploading || busy}
              />
            </View>
          }
          trailing={
            <View style={[styles.line, { gap: 0 }]}>
              {running && (
                <View ref={modeButton} collapsable={false}>
                  <Tap
                    label={`${steering ? "Steer now" : "Queue follow-up"}. Change send mode`}
                    disabled={busy}
                    onPress={() => {
                      void measureSendView(modeButton.current).then((rect) => {
                        if (rect) {
                          setModeOrigin(rect);
                          setModeOpen(true);
                        }
                      });
                    }}
                    style={{ width: 44, alignItems: "center" }}
                  >
                    <Icon
                      name={
                        steering ? "arrow.up.right" : "arrow.turn.down.right"
                      }
                      size={18}
                      color={colors.secondary}
                    />
                  </Tap>
                </View>
              )}
              <IconButton
                name={
                  running && onStop && !text.trim() && !attachments.length
                    ? "stop.fill"
                    : running && !steering
                      ? "arrow.turn.down.right"
                      : "arrow.up"
                }
                label={
                  running && onStop && !text.trim() && !attachments.length
                    ? "Stop agent"
                    : steering
                      ? "Steer now"
                      : running
                        ? "Queue follow-up"
                        : "Send message"
                }
                filled
                onPress={() => {
                  if (running && onStop && !text.trim() && !attachments.length)
                    onStop();
                  else void send();
                }}
                disabled={
                  disabled ||
                  busy ||
                  uploading ||
                  (!text.trim() && !attachments.length && !(running && onStop))
                }
              />
            </View>
          }
        />
      </Animated.View>
      {(uploading || (busy && running)) && (
        <T variant="caption" tone="secondary">
          {uploading
            ? "Attaching files…"
            : steering
              ? "Steering…"
              : running
                ? "Queueing follow-up…"
                : "Sending…"}
        </T>
      )}
    </View>
  );
});
