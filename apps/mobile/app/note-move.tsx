import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { attempt } from "../src/features/noteActions";
import { moveNote, useNotes } from "../src/state/notes";
import { noteTitle } from "../src/state/notesModel";
import { isFreeChatProject } from "../src/state/protocol";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { InsetGroup, ListRow } from "../src/ui/List";
import { Empty, Page, T } from "../src/ui/primitives";
import { ProjectDot } from "../src/ui/TaskGlyphs";
import { space, useTheme } from "../src/ui/theme";

/** Choose where a note lives: Global, or one of the computer's projects. */
export default function MoveNote() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const app = useApp();
  const { colors } = useTheme();
  const { notes } = useNotes();
  const note = notes.find((n) => n.id === id);
  const [busy, setBusy] = useState(false);
  function choose(projectId: string | null) {
    if (!note || busy) return;
    setBusy(true);
    attempt(
      () => moveNote(note.id, projectId),
      () => router.back(),
    );
    // A failure shows an alert; let the reader pick again.
    setTimeout(() => setBusy(false), 600);
  }
  if (!note)
    return (
      <Page grouped>
        <Empty
          icon="doc.text"
          title="Note not found"
          detail="It may have been deleted. Close this and try again."
        />
      </Page>
    );
  const current = note.scope === "project" ? note.project_id : null;
  const projects = app.projects.filter((p) => !isFreeChatProject(p.id));
  return (
    <Page grouped>
      <Stack.Screen options={{ headerStyle: { backgroundColor: colors.grouped } }} />
      <T variant="subhead" tone="secondary" style={{ marginBottom: space.lg }}>
        Choose where “{noteTitle(note)}” lives.
      </T>
      <InsetGroup>
        <ListRow
          title="Global"
          subtitle={`On ${activeEnvironment()?.name ?? "your computer"}`}
          leading="doc.text"
          checked={current === null}
          disabled={busy}
          onPress={current === null ? undefined : () => choose(null)}
        />
        {projects.map((p) => (
          <ListRow
            key={p.id}
            title={p.name}
            leading={<ProjectDot projectId={p.id} size={8} />}
            checked={current === p.id}
            disabled={busy}
            onPress={current === p.id ? undefined : () => choose(p.id)}
          />
        ))}
      </InsetGroup>
    </Page>
  );
}
