// One file: source or rendered Markdown, copy, add to the message, and a quick edit (parity
// P2-9). Saving sends the version the edit started from, so a file that changed on the computer
// is never overwritten silently: the user reloads it or keeps their own text.
import * as Clipboard from "expo-clipboard";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, TextInput, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatFileContext } from "../src/state/chatFileContext";
import type { FilesReadResult } from "../src/state/protocol";
import { errorText, rpc } from "../src/state/runtime";
import { addContext } from "../src/state/draft";
import { HeaderActions, type HeaderButton } from "../src/ui/ActionMenu";
import { Alert, confirm } from "../src/ui/Alert";
import { Markdown } from "../src/ui/Markdown";
import { SourceCode } from "../src/ui/SourceCode";
import { Segmented } from "../src/ui/Segmented";
import { showToast } from "../src/ui/Toast";
import { haptics } from "../src/ui/haptics";
import { Button, Empty, ErrorBanner, T } from "../src/ui/primitives";
import { MONO, gutter, space, useTextScale, useTheme, useType } from "../src/ui/theme";
import { Working } from "../src/ui/Working";

/** Largest file the phone reads, and so the largest it can edit whole. */
const MAX_BYTES = 128000;
const CONFLICT = -32004;

export default function FileScreen() {
  const { projectId, threadId, path, scope, line } = useLocalSearchParams<{
    projectId: string;
    threadId?: string;
    path: string;
    scope?: string;
    line?: string;
  }>();
  const [file, setFile] = useState<FilesReadResult>();
  const [raw, setRaw] = useState(!!line);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const { fontScale, width } = useWindowDimensions();
  const typography = useType();
  const { textScale } = useTextScale();
  const insets = useSafeAreaInsets();
  const thread = scope === "thread" && !!threadId;
  const fileContext = useMemo(() => threadId ? { threadId, projectId, basePath: path, scope: scope === "thread" ? "thread" as const : "project" as const } : null, [threadId, projectId, path, scope]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const { colors } = useTheme();
  const name = path.split("/").at(-1) ?? "File";
  const language = path.split(".").at(-1)?.toLowerCase() ?? "";
  const markdown = /^(md|mdx|markdown)$/.test(language);
  const dirty = editing && !!file && text !== file.content;
  const editable = !!file && !file.binary && !file.truncated;
  const read = () =>
    thread
      ? rpc("threads.files.read", { thread_id: threadId!, path, max_bytes: MAX_BYTES })
      : rpc("files.read", { project_id: projectId, path, max_bytes: MAX_BYTES });
  useEffect(() => {
    let alive = true;
    setError("");
    setFile(undefined);
    void read()
      .then((data) => {
        if (alive) setFile(data);
      })
      .catch((e) => {
        if (alive) setError((e as { code?: number }).code === -32601 ? "Update Kybern on the connected computer to open chat file links." : errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [projectId, threadId, scope, path, retry]);

  async function save(overwrite = false) {
    if (!file) return;
    setSaving(true);
    setError("");
    const params = { path, content: text, ...(overwrite ? {} : { expected_version: file.version }) };
    try {
      const saved = thread
        ? await rpc("threads.files.write", { thread_id: threadId!, ...params })
        : await rpc("files.write", { project_id: projectId, ...params });
      setFile({ ...file, content: text, version: saved.version, size: saved.size });
      setEditing(false);
      haptics.success();
      showToast(`Saved ${name}`);
    } catch (e) {
      if ((e as { code?: number }).code === CONFLICT || /changed on disk/.test(errorText(e))) conflict();
      else setError(`Unable to save ${name}. ${errorText(e)}`);
    } finally {
      setSaving(false);
    }
  }
  function conflict() {
    Alert.alert(`“${name}” changed on your computer`, "Reload it to see the new version and lose your edits, or keep your text and replace the file.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reload",
        onPress: () =>
          void read().then(
            (data) => {
              setFile(data);
              setText(data.content);
              setEditing(false);
            },
            (e) => setError(errorText(e)),
          ),
      },
      { text: "Keep mine", style: "destructive", onPress: () => void save(true) },
    ]);
  }
  function stopEditing() {
    if (!dirty) return setEditing(false);
    confirm({
      title: "Discard your edits?",
      message: `Your changes to ${name} have not been saved.`,
      confirm: "Discard",
      onConfirm: () => setEditing(false),
    });
  }

  const buttons: HeaderButton[] = editing
    ? [
        { title: "Save", prominent: true, disabled: !dirty || saving, onPress: () => void save() },
      ]
    : [
        {
          title: "Edit",
          disabled: !editable,
          onPress: () => {
            setText(file!.content);
            setRaw(true);
            setEditing(true);
          },
        },
      ];
  return (
    <ChatFileContext value={fileContext}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.background }}>
        <Stack.Screen
          options={{
            title: name,
            headerBackVisible: !editing,
            gestureEnabled: !dirty,
            headerLeft: editing
              ? () => (
                  <Button role="plain" size="medium" onPress={stopEditing}>
                    Cancel
                  </Button>
                )
              : undefined,
          }}
        />
        <HeaderActions
          buttons={buttons}
          menu={
            editing
              ? undefined
              : {
                  label: "File actions",
                  items: [
                    {
                      title: "Copy contents",
                      icon: "doc.on.doc",
                      disabled: !file || file.binary,
                      onPress: () => {
                        void Clipboard.setStringAsync(file?.content ?? "");
                        showToast("Contents copied");
                      },
                    },
                    {
                      title: "Copy path",
                      icon: "link",
                      onPress: () => {
                        void Clipboard.setStringAsync(path);
                        showToast("Path copied");
                      },
                    },
                  ],
                }
          }
        />
        <View style={{ paddingHorizontal: gutter(width), paddingTop: space.sm, paddingBottom: space.md, gap: space.md }}>
          <T variant="code" tone="muted" numberOfLines={1} ellipsizeMode="middle" selectable>
            {path}{line ? ` · Line ${line}` : ""}
          </T>
          {markdown && !editing && (
            <Segmented
              compact
              label="Show Markdown as"
              options={[
                { value: "preview", label: "Preview" },
                { value: "raw", label: "Source" },
              ]}
              value={raw ? "raw" : "preview"}
              onChange={(value) => setRaw(value === "raw")}
            />
          )}
          {editing && dirty && (
            <T variant="footnote" tone="secondary">
              Edited · not saved
            </T>
          )}
          <ErrorBanner error={error} onRetry={editing ? undefined : () => setRetry((n) => n + 1)} />
        </View>
        {editing ? (
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            textAlignVertical="top"
            accessibilityLabel={`Edit ${name}`}
            selectionColor={colors.accent}
            underlineColorAndroid="transparent"
            style={[
              typography.mono,
              {
                flex: 1,
                color: colors.ink,
                fontFamily: MONO,
                letterSpacing: 0,
                paddingHorizontal: gutter(width),
                paddingBottom: insets.bottom + space.lg,
              },
            ]}
          />
        ) : (
          <>
            <ScrollView
              ref={scroll}
              onContentSizeChange={() => {
                const target = Number(line);
                if (file && raw && Number.isSafeInteger(target) && target > 0) scroll.current?.scrollTo({ y: Math.max(0, (target - 1) * 21 * fontScale * textScale), animated: false });
              }}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: space.xl }}
            >
              {!file && !error ? (
                <Working label="Opening file" />
              ) : file?.binary ? (
                <Empty icon="doc" title="Binary file" detail="This file can't be shown as text." />
              ) : file ? (
                markdown && !raw ? (
                  <View style={{ paddingHorizontal: gutter(width) }}>
                    <Markdown text={file.content} />
                  </View>
                ) : (
                  <SourceCode text={file.content} language={language} />
                )
              ) : null}
              {file?.truncated && (
                <T variant="footnote" tone="muted" style={{ padding: gutter(width) }}>
                  Showing the first 128 KB. Edit larger files on your computer.
                </T>
              )}
            </ScrollView>
            <View style={{ paddingHorizontal: gutter(width), paddingTop: space.md, paddingBottom: Math.max(insets.bottom, space.lg) }}>
              <Button
                role="tinted"
                icon="paperclip"
                onPress={() => {
                  addContext(threadId ?? "new", { type: "file_mention", path });
                  if (threadId) router.dismissTo({ pathname: "/thread/[id]", params: { id: threadId } });
                  else router.dismissTo("/");
                }}
              >
                Add to message
              </Button>
            </View>
          </>
        )}
      </KeyboardAvoidingView>
    </ChatFileContext>
  );
}
