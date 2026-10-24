import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { editedLabel, NoteView } from "../src/features/NoteView";
import { noteMenuItems } from "../src/features/noteActions";
import { HeaderActions } from "../src/ui/ActionMenu";
import { noteMarkdown } from "../src/state/notesModel";
import type { NoteTarget } from "../src/state/noteSession";
import { useNoteSession } from "../src/state/useNoteSession";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { Button, T } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";

export default function NoteScreen() {
  const { id, new: fresh, projectId } = useLocalSearchParams<{
    id?: string;
    new?: string;
    projectId?: string;
  }>();
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
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
  const place =
    note?.scope === "thread"
      ? `Thread note${projectName ? ` · ${projectName}` : ""}`
      : (note?.scope === "project" || (!note && projectId)) && projectName
        ? projectName
        : `Global · on ${activeEnvironment()?.name ?? "your computer"}`;
  // One location line above the title: "kybern · Edited 11d ago".
  const where = [place, editing ? "" : editedLabel(note?.updated_at)].filter(Boolean).join(" · ");
  function setMode(next: boolean) {
    if (!next) void s.session.flush();
    setEditing(next);
  }
  const meta = (
    <View style={{ gap: space.md, marginBottom: space.md, alignItems: "flex-start" }}>
      <T variant="footnote" tone="secondary">
        {where}
      </T>
      {thread && note?.thread_id && !editing && (
        <Button
          size="medium"
          icon="text.bubble"
          onPress={() =>
            router.push({
              pathname: "/thread/[id]",
              params: { id: note.thread_id! },
            })
          }
        >
          Open thread
        </Button>
      )}
    </View>
  );
  const content = {
    paddingHorizontal: gutter(width),
    paddingTop: space.sm,
    width: "100%" as const,
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: "center" as const,
  };
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <Stack.Screen options={{ title: "" }} />
      <HeaderActions
        buttons={[
          {
            title: editing ? "Done" : "Edit",
            prominent: editing,
            disabled: !s.loaded || s.deleted,
            onPress: () => setMode(!editing),
          },
        ]}
        menu={
          note
            ? {
                label: "Note options",
                items: noteMenuItems(
                  { ...note, title: s.title || note.title, deleted_at: note.deleted_at },
                  {
                    markdown: () => noteMarkdown(s.title, s.body),
                    afterDelete: () => router.back(),
                  },
                ),
              }
            : undefined
        }
      />
      {editing && !s.deleted ? (
        <View
          style={{
            flex: 1,
            ...content,
            paddingBottom: Math.max(insets.bottom, space.lg),
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
            paddingBottom: insets.bottom + space["2xl"],
          }}
        >
          {meta}
          <NoteView s={s} editing={false} showTitle />
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
