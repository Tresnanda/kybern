import { buildStructuredTextParts } from "../../../../packages/kybern-client/src/composerTokens";
import * as DocumentPicker from "expo-document-picker";
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
  const recoil = useSharedValue(1);
  const composerMotion = useAnimatedStyle(() => ({
    transform: [{ scale: recoil.get() }],
  }));
  const addButton = useRef<View>(null);
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
    setError("");
    try {
      const skillItems = /(?:^|\s)[$@]/.test(text)
        ? (
            await rpc("skills.list", {
              project_id: thread?.project_id ?? draft.projectId,
              provider: thread?.provider.kind ?? draft.provider,
            })
          ).skills
        : [];
      const message: UserMessage = {
        parts: [
          ...attachments,
          ...buildStructuredTextParts(text, new Set(), skillItems),
        ],
      };
      const sources: Record<string, SendSource> = {};
      if (!reduced) {
        const textRect = await measureSendView(inputBounds.current);
        if (textRect && text.trim())
          sources.text = {
            rect: {
              x: textRect.x + 9,
              y: textRect.y + 8,
              width: textRect.width - 18,
              height: Math.max(
                22,
                Math.min(textRect.height - 23, inputContentHeight.current),
              ),
            },
          };
        await Promise.all(
          message.parts.map(async (part, index) => {
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
        );
      }
      const receipt = await (steering ? onSteer! : onSend)(message);
      if (receipt) sendTransition.start(receipt, message, sources);
      if (!running) Keyboard.dismiss();
      if (!reduced)
        recoil.set(
          withSequence(
            withSpring(0.985, { duration: 100, dampingRatio: 1 }),
            withSpring(1, { duration: 300, dampingRatio: 0.8 }),
          ),
        );
      setText("");
      setAttachments([]);
      attachmentUris.current.clear();
      lastPrompt.current = "";
      onPromptConsumed?.();
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (e) {
      setError(errorText(e));
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  async function attach() {
    const env = activeEnvironment();
    if (!env) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      setUploading(true);
      setError("");
      for (const asset of picked.assets) {
        if ((asset.size ?? 0) > 25 * 1024 * 1024)
          throw new Error("Choose a file smaller than 25 MB.");
        const file = new File(asset.uri);
        const response = await expoFetch(`${httpBase(env.url)}/assets`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.token}`,
            "content-type": asset.mimeType ?? "application/octet-stream",
            "x-kybern-filename": encodeURIComponent(asset.name),
          },
          body: file,
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
        attachmentUris.current.set(result.id, asset.uri);
        setAttachments((prev) => [
          ...prev,
          {
            type: "attachment",
            asset_id: result.id,
            name: result.name,
            media_type: result.media_type,
            size: result.size,
          },
        ]);
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
      {addOrigin && (
        <MorphingMenu
          origin={addOrigin}
          open={adding}
          placement="above"
          onClose={() => setAdding(false)}
          onClosed={finishAddClose}
        >
          <Tap
            label="Attach a file"
            onPress={() =>
              chooseAddAction(() => {
                void attach();
              })
            }
            style={[styles.line, { paddingHorizontal: 12 }]}
          >
            <Icon name="paperclip" size={18} />
            <T variant="label">Attach a file</T>
          </Tap>
          <Tap
            label="Mention a project file"
            onPress={() =>
              chooseAddAction(() => {
                router.push({
                  pathname: "/workspace",
                  params: thread
                    ? { threadId: thread.id, tab: "Files" }
                    : { projectId: draft.projectId, tab: "Files" },
                });
              })
            }
            style={[styles.line, { paddingHorizontal: 12 }]}
          >
            <Icon name="folder" size={18} />
            <T variant="label">Mention a project file</T>
          </Tap>
          <Tap
            label="Skills, plugins, and commands"
            onPress={() => chooseAddAction(() => openCapabilities())}
            style={[styles.line, { paddingHorizontal: 12 }]}
          >
            <Icon name="sparkles" size={18} />
            <T variant="label">Skills, plugins & commands</T>
          </Tap>
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
        layout={reduced ? undefined : COMPOSER_REFLOW}
        style={[
          composerMotion,
          {
            borderRadius: 26,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.line,
            padding: 10,
            boxShadow: `0 3px 12px ${colors.backdrop.slice(0, 7)}08`,
          },
        ]}
      >
        {attachments.length > 0 && (
          <Animated.View layout={reduced ? undefined : COMPOSER_REFLOW}>
            <ScrollView
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
                    layout={reduced ? undefined : COMPOSER_REFLOW}
                    entering={ATTACH_ENTER}
                    exiting={ATTACH_EXIT}
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
                            style={{ width: 72, height: 72, borderRadius: 16 }}
                            resizeMode="contain"
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
          </Animated.View>
        )}

        {running && onSteer && (
          <View style={[styles.line, { gap: 6, paddingHorizontal: 8 }]}>
            {(["queue", "steer"] as const).map((mode) => (
              <Tap
                key={mode}
                label={mode === "queue" ? "Queue follow-up" : "Steer now"}
                selected={promptMode === mode}
                disabled={busy}
                onPress={() => setPromptMode(mode)}
                style={{
                  paddingHorizontal: 12,
                  minHeight: 44,
                  justifyContent: "center",
                  borderRadius: 14,
                  backgroundColor:
                    promptMode === mode ? colors.background : "transparent",
                }}
              >
                <T
                  variant="caption"
                  tone={promptMode === mode ? undefined : "secondary"}
                >
                  {mode === "queue" ? "Queue follow-up" : "Steer now"}
                </T>
              </Tap>
            ))}
          </View>
        )}
        <View ref={inputBounds} collapsable={false}>
          <TextInput
            underlineColorAndroid="transparent"
            ref={input}
            accessibilityLabel={running ? "Follow-up message" : "Message"}
            placeholder={
              steering
                ? "Guide the current turn…"
                : running
                  ? "Add a follow-up…"
                  : "Ask Kybern to build something…"
            }
            placeholderTextColor={colors.muted}
            value={text}
            onChangeText={(value) => {
              setText(value);
              setDismissed("");
            }}
            onSelectionChange={(event) =>
              setSelection(event.nativeEvent.selection)
            }
            onContentSizeChange={(event) => {
              inputContentHeight.current = Math.max(
                22,
                event.nativeEvent.contentSize.height - 23,
              );
            }}
            multiline
            editable={!busy}
            selectionColor={colors.accent}
            style={[
              type.body,
              {
                color: colors.ink,
                minHeight: 60,
                maxHeight: 180,
                paddingHorizontal: 9,
                paddingTop: 8,
                paddingBottom: 15,
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
              {running && onStop && (
                <IconButton
                  name="stop.fill"
                  label="Stop agent"
                  onPress={onStop}
                />
              )}
              <IconButton
                name={
                  running && !steering ? "arrow.turn.down.right" : "arrow.up"
                }
                label={
                  steering
                    ? "Steer now"
                    : running
                      ? "Queue follow-up"
                      : "Send message"
                }
                filled
                onPress={() => void send()}
                disabled={
                  disabled ||
                  busy ||
                  uploading ||
                  (!text.trim() && !attachments.length)
                }
              />
            </View>
          }
        />
      </Animated.View>
      {(busy || uploading) && (
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
