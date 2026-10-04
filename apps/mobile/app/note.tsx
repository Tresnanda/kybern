import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ModeToggle, NoteView } from "../src/features/NoteView";
import { noteMenu } from "../src/features/noteActions";
import { noteMarkdown } from "../src/state/notesModel";
import type { NoteTarget } from "../src/state/noteSession";
import { useNoteSession } from "../src/state/useNoteSession";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { IconButton, Icon, styles, T, Tap } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function NoteScreen() {
  const { id, new: fresh, projectId } = useLocalSearchParams<{
    id?: string;
    new?: string;
    projectId?: string;
  }>();
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const target = useMemo<NoteTarget>(
    () => (id ? { kind: "id", id } : { kind: "new", projectId: projectId || null }),
    [id, projectId],
  );
  const s = useNoteSession(target);
  // A new note opens ready to type; a saved one opens ready to read.
  const [editing, setEditing] = useState(fresh === "1" && !id);
  const note = s.note;
  const thread = note?.scope === "thread";
  const projectName = (note?.project_id ?? projectId)
    ? app.projects.find((p) => p.id === (note?.project_id ?? projectId))?.name
    : undefined;
  const where =
    note?.scope === "thread"
      ? `Thread note${projectName ? ` · ${projectName}` : ""}`
      : (note?.scope === "project" || (!note && projectId)) && projectName
        ? projectName
        : `Global note · on ${activeEnvironment()?.name ?? "your computer"}`;
  function setMode(next: boolean) {
    if (!next) void s.session.flush();
    setEditing(next);
  }
  const meta = (
    <View style={{ gap: 4, marginBottom: 12 }}>
      <T variant="caption" tone="muted">
        {where}
      </T>
      {thread && note?.thread_id && (
        <Tap
          label="Open thread"
          onPress={() =>
            router.push({
              pathname: "/thread/[id]",
              params: { id: note.thread_id! },
            })
          }
          style={[styles.line, { gap: 8 }]}
        >
          <Icon name="text.bubble" size={16} color={colors.accent} />
          <T variant="label" tone="accent">
            Open thread
          </T>
        </Tap>
      )}
    </View>
  );
  const content = {
    paddingHorizontal: 24,
    paddingTop: 8,
    width: "100%" as const,
    maxWidth: 760,
    alignSelf: "center" as const,
  };
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <Stack.Screen
        options={{
          title: "",
          headerRight: () => (
            <View style={styles.line}>
              <ModeToggle
                editing={editing}
                onChange={setMode}
                disabled={!s.loaded || s.deleted}
              />
              {note && (
                <IconButton
                  name="ellipsis"
                  label="Note options"
                  onPress={() =>
                    noteMenu(
                      { ...note, title: s.title || note.title, deleted_at: note.deleted_at },
                      {
                        markdown: () => noteMarkdown(s.title, s.body),
                        afterDelete: () => router.back(),
                      },
                    )
                  }
                />
              )}
            </View>
          ),
        }}
      />
      {editing && !s.deleted ? (
        <View
          style={{
            flex: 1,
            ...content,
            paddingBottom: Math.max(insets.bottom, 16),
          }}
        >
          {meta}
          <NoteView s={s} editing showTitle fill autoFocusBody={fresh === "1"} />
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            ...content,
            paddingBottom: insets.bottom + 40,
          }}
        >
          {meta}
          <NoteView s={s} editing={false} showTitle />
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
