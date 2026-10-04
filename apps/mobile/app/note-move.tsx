import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { attempt } from "../src/features/noteActions";
import { moveNote, useNotes } from "../src/state/notes";
import { noteTitle } from "../src/state/notesModel";
import { isFreeChatProject } from "../src/state/protocol";
import { activeEnvironment, useApp } from "../src/state/runtime";
import { Empty, Icon, Page, Row, T } from "../src/ui/primitives";

/** Choose where a note lives: Global, or one of the computer's projects. */
export default function MoveNote() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const app = useApp();
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
      <Page>
        <Empty
          icon="doc.text"
          title="Note not found"
          detail="It may have been deleted. Close this and try again."
        />
      </Page>
    );
  const current = note.scope === "project" ? note.project_id : null;
  const check = <Icon name="checkmark" size={18} />;
  return (
    <Page>
      <T variant="heading" style={{ marginBottom: 4 }}>
        Move “{noteTitle(note)}”
      </T>
      <T variant="caption" tone="secondary" style={{ marginBottom: 12 }}>
        Choose where this note lives.
      </T>
      <Row
        title="Global"
        detail={`On ${activeEnvironment()?.name ?? "your computer"}`}
        icon="doc.text"
        trailing={current === null ? check : undefined}
        onPress={current === null ? undefined : () => choose(null)}
      />
      {app.projects.filter((p) => !isFreeChatProject(p.id)).map((p) => (
        <Row
          key={p.id}
          title={p.name}
          icon="folder"
          trailing={current === p.id ? check : undefined}
          onPress={current === p.id ? undefined : () => choose(p.id)}
        />
      ))}
    </Page>
  );
}
