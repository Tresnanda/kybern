// The Coordinator's project space on the phone: the brief (read, or edited in place;
// the first character creates it), the setup note, memory notes, and the switch that
// gives every new thread in the project the brief, then the project's Coordinator settings.
// Shown in the Project sheet.
import { router } from "expo-router";
import { memo, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import {
  PROJECT_SPACE_COPY,
  notePreviewLine,
  projectSpaceNotes,
} from "../../../../packages/kybern-client/src/projectSpace";
import { SPACE_COPY } from "../../../../packages/kybern-client/src/spaces";
import { useNotes } from "../state/notes";
import { noteTitle } from "../state/notesModel";
import type { NoteSummary, Space, Thread } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { relativeTime } from "../state/threadList";
import { useNoteSession } from "../state/useNoteSession";
import { ErrorBanner, T, Tap, styles } from "../ui/primitives";
import { Toggle } from "../ui/Toggle";
import { useTheme } from "../ui/theme";
import { NoteView, Pill } from "./NoteView";
import { ProjectCoordinatorSection } from "./ProjectCoordinator";

/** Rows shown before "Show all in Notes", like the desktop dock. */
const MEMORY_LIMIT = 50;

function SectionLabel({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  return (
    <View style={[styles.spread, { minHeight: 44, paddingTop: 12 }]}>
      <T variant="footnote" tone="secondary" accessibilityRole="header">
        {title}
      </T>
      {trailing}
    </View>
  );
}

export function ProjectSpace({ projectId }: { projectId: string }) {
  const { colors } = useTheme();
  const app = useApp();
  const { notes, loaded, unsupported, error } = useNotes();
  const { brief, setup, memory } = useMemo(() => projectSpaceNotes(notes, projectId), [notes, projectId]);
  const threads = app.threads;

  if (unsupported)
    return <T tone="secondary">This computer needs a newer Kybern to keep project notes. Update Kybern on the computer, then try again.</T>;
  if (!loaded) return error ? <ErrorBanner error={error} /> : <T tone="secondary">Loading project notes…</T>;
  return (
    <View>
      {/* Keyed by project only: once the brief is created, the same editor keeps going. */}
      <BriefSection key={projectId} projectId={projectId} briefId={brief?.id ?? null} />
      <SectionLabel title="Setup" />
      {setup ? (
        <NoteRow note={setup} threads={threads} />
      ) : (
        <T variant="footnote" tone="muted">{PROJECT_SPACE_COPY.setupEmpty}</T>
      )}
      <SectionLabel title={memory.length ? `Memory · ${memory.length}` : "Memory"} />
      {memory.length ? (
        <View style={{ borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 }}>
          {memory.slice(0, MEMORY_LIMIT).map((note, index) => (
            <View key={note.id} style={index ? { borderTopWidth: 1, borderColor: colors.line } : undefined}>
              <NoteRow note={note} threads={threads} />
            </View>
          ))}
        </View>
      ) : (
        <T variant="footnote" tone="muted">{PROJECT_SPACE_COPY.memoryEmpty}</T>
      )}
      <ProjectCoordinatorSection projectId={projectId} />
      <BriefSwitch projectId={projectId} />
      <SpaceRow projectId={projectId} />
      <Tap
        label="Show all in Notes"
        onPress={() => router.push({ pathname: "/notes", params: { projectId } })}
        style={{ marginTop: 8, alignItems: "flex-start" }}
      >
        <T variant="label" tone="accent">Show all in Notes</T>
      </Tap>
    </View>
  );
}

/** The brief, read as Markdown; Edit turns it into the Markdown text in place. */
function BriefSection({ projectId, briefId }: { projectId: string; briefId: string | null }) {
  const { colors } = useTheme();
  // The target is fixed when the sheet opens: the brief by id, or a new one created on the first character.
  const [target] = useState(() => (briefId ? { kind: "id" as const, id: briefId } : { kind: "new" as const, projectId, role: "brief" as const }));
  const s = useNoteSession(target);
  const [editing, setEditing] = useState(false);
  const empty = !s.body.trim();
  const setMode = (next: boolean) => {
    if (!next) void s.session.flush();
    setEditing(next);
  };
  return (
    <View>
      <SectionLabel
        title="Brief"
        trailing={<Pill label={editing ? "Done" : empty ? "Write" : "Edit"} primary={editing} disabled={!s.loaded || s.deleted} onPress={() => setMode(!editing)} />}
      />
      <View style={{ padding: 14, borderRadius: 16, backgroundColor: colors.raised, gap: 8 }}>
        {empty && !editing ? (
          <Tap label="Write the brief" onPress={() => setMode(true)} style={{ alignItems: "flex-start" }}>
            <T tone="secondary">{PROJECT_SPACE_COPY.briefEmpty}</T>
          </Tap>
        ) : (
          <NoteView
            s={s}
            editing={editing}
            showTitle={false}
            autoFocusBody={editing}
            maxEditorHeight={260}
            placeholder={PROJECT_SPACE_COPY.briefPlaceholder}
            emptyText={PROJECT_SPACE_COPY.briefEmpty}
            saveFailedText={PROJECT_SPACE_COPY.briefSaveFailed}
          />
        )}
      </View>
      <T variant="footnote" tone="muted" style={{ marginTop: 8 }}>{PROJECT_SPACE_COPY.briefOwner}</T>
    </View>
  );
}

/** Who wrote a note: the agent thread's name, or you. */
function author(note: NoteSummary, threads: readonly Thread[]): string {
  if (!note.created_by_thread) return "You";
  const thread = threads.find((item) => item.id === note.created_by_thread);
  return thread?.coordinator_project_id ? "Coordinator" : thread?.title?.trim() || "An agent";
}

const NoteRow = memo(function NoteRow({ note, threads }: { note: NoteSummary; threads: readonly Thread[] }) {
  const title = noteTitle(note);
  const preview = notePreviewLine(note);
  return (
    <Tap label={`${title}, ${author(note, threads)}`} onPress={() => router.push({ pathname: "/note", params: { id: note.id } })} static style={{ paddingVertical: 10, gap: 2 }}>
      <View style={[styles.spread, { gap: 8 }]}>
        <T variant="label" numberOfLines={1} style={{ flex: 1 }}>{title}</T>
        <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>{relativeTime(note.updated_at)}</T>
      </View>
      <T variant="footnote" tone="secondary" numberOfLines={1}>
        {author(note, threads)}
        {preview ? ` · ${preview}` : ""}
      </T>
    </Tap>
  );
});

/** "Give every thread in this project the brief": `projects.update brief_in_all_threads`. */
function BriefSwitch({ projectId }: { projectId: string }) {
  const { colors } = useTheme();
  const app = useApp();
  const saved = app.projects.find((project) => project.id === projectId)?.brief_in_all_threads ?? false;
  // Shown at once; `projects.changed` confirms it, a failure puts it back.
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const value = pending ?? saved;
  const change = (next: boolean) => {
    setPending(next);
    setError("");
    rpc("projects.update", { project_id: projectId, brief_in_all_threads: next })
      .catch((e) => setError(`${PROJECT_SPACE_COPY.switchFailed} ${errorText(e)}`))
      .finally(() => setPending(null));
  };
  return (
    <View style={{ marginTop: 24, gap: 8 }}>
      <View style={[styles.line, { gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label">{PROJECT_SPACE_COPY.switchTitle}</T>
          <T variant="footnote" tone="secondary">{PROJECT_SPACE_COPY.switchDetail}</T>
        </View>
        <Toggle value={value} onValueChange={change} disabled={pending !== null} accessibilityLabel={PROJECT_SPACE_COPY.switchTitle} />
      </View>
      <ErrorBanner error={error} />
    </View>
  );
}

/** Which space the project is in, and whether it is the default one. Read-only: spaces are managed on the computer. */
function SpaceRow({ projectId }: { projectId: string }) {
  const { colors } = useTheme();
  const app = useApp();
  const spaceId = app.projects.find((project) => project.id === projectId)?.space_id;
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    let live = true;
    // A computer without spaces answers with an error: the row stays hidden.
    rpc("spaces.list", {})
      .then((result) => live && setSpace(result.spaces.find((item) => item.id === spaceId) ?? null))
      .catch(() => live && setSpace(null));
    return () => {
      live = false;
    };
  }, [spaceId]);
  if (!space) return null;
  return (
    <View style={{ marginTop: 24 }}>
      <View style={[styles.line, { gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface }]}>
        <View style={{ flex: 1, gap: 2 }}>
          <T variant="label">{space.name}</T>
          <T variant="footnote" tone="secondary">{space.is_default ? SPACE_COPY.defaultBadge : "Space"}</T>
        </View>
      </View>
    </View>
  );
}
