// The Coordinator's project space on the phone: the brief (read, or edited in place;
// the first character creates it), the setup note, memory notes, and the switch that
// gives every new thread in the project the brief, then the project's Coordinator settings.
// Shown in the Project sheet.
import { router } from "expo-router";
import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import {
  PROJECT_SPACE_COPY,
  notePreviewLine,
  projectSpaceNotes,
} from "../../../../packages/kybern-client/src/projectSpace";
import { useNotes } from "../state/notes";
import { noteTitle } from "../state/notesModel";
import type { NoteSummary, Thread } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { moveProjectToSpace, SPACE_COPY, useSpaces } from "../state/spaces";
import { relativeTime } from "../state/threadList";
import { useNoteSession } from "../state/useNoteSession";
import { Busy } from "../ui/Busy";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import type { MenuItem } from "../ui/menuModel";
import { ErrorBanner, T, Tap } from "../ui/primitives";
import { SpaceTile } from "../ui/SpaceTile";
import { Toggle } from "../ui/Toggle";
import { radius, space, useTheme } from "../ui/theme";
import { showToast } from "../ui/Toast";
import { NoteView } from "./NoteView";
import { ProjectCoordinatorSection } from "./ProjectCoordinator";

/** Rows shown before "Show all in Notes", like the desktop dock. */
const MEMORY_LIMIT = 50;

export function ProjectSpace({ projectId }: { projectId: string }) {
  const app = useApp();
  const { notes, loaded, unsupported, error } = useNotes();
  const { brief, setup, memory } = useMemo(() => projectSpaceNotes(notes, projectId), [notes, projectId]);
  const threads = app.threads;

  if (unsupported)
    return <T tone="secondary">This computer needs a newer Kybern to keep project notes. Update Kybern on the computer, then try again.</T>;
  if (!loaded) return error ? <ErrorBanner error={error} /> : <Busy />;
  return (
    <View>
      {/* Keyed by project only: once the brief is created, the same editor keeps going. */}
      <BriefSection key={projectId} projectId={projectId} briefId={brief?.id ?? null} />
      <SectionHeader title="Setup" inset />
      {setup ? (
        <InsetGroup>
          <NoteRow note={setup} threads={threads} />
        </InsetGroup>
      ) : (
        <SectionFooter inset>{PROJECT_SPACE_COPY.setupEmpty}</SectionFooter>
      )}
      <SectionHeader
        title="Memory"
        count={memory.length || undefined}
        inset
        action={{ title: "Show all", label: "Show all in Notes", onPress: () => router.push({ pathname: "/notes", params: { projectId } }) }}
      />
      {memory.length ? (
        <InsetGroup>
          {memory.slice(0, MEMORY_LIMIT).map((note) => (
            <NoteRow key={note.id} note={note} threads={threads} />
          ))}
        </InsetGroup>
      ) : (
        <SectionFooter inset>{PROJECT_SPACE_COPY.memoryEmpty}</SectionFooter>
      )}
      <ProjectCoordinatorSection projectId={projectId} />
      <BriefSwitch projectId={projectId} />
      <SpaceRow projectId={projectId} />
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
  const ready = s.loaded && !s.deleted;
  return (
    <View>
      <SectionHeader
        title="Brief"
        inset
        first
        action={ready ? { title: editing ? "Done" : empty ? "Write" : "Edit", onPress: () => setMode(!editing) } : undefined}
      />
      <View style={{ padding: space.lg, borderRadius: radius.md, backgroundColor: colors.surface, gap: space.sm }}>
        {empty && !editing ? (
          <Tap label="Write the brief" feedback="none" onPress={() => setMode(true)} style={{ alignItems: "flex-start" }}>
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
      <SectionFooter inset>{PROJECT_SPACE_COPY.briefOwner}</SectionFooter>
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
  const preview = notePreviewLine(note);
  return (
    <ListRow
      title={noteTitle(note)}
      subtitle={`${author(note, threads)}${preview ? ` · ${preview}` : ""}`}
      subtitleLines={1}
      meta={relativeTime(note.updated_at)}
      onPress={() => router.push({ pathname: "/note", params: { id: note.id } })}
    />
  );
});

/** "Give every thread in this project the brief": `projects.update brief_in_all_threads`. */
function BriefSwitch({ projectId }: { projectId: string }) {
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
    <View>
      <View style={{ height: space["2xl"] }} />
      <InsetGroup>
        <ListRow
          title={PROJECT_SPACE_COPY.switchTitle}
          titleLines={2}
          subtitle={PROJECT_SPACE_COPY.switchDetail}
          trailing={<Toggle value={value} onValueChange={change} disabled={pending !== null} accessibilityLabel={PROJECT_SPACE_COPY.switchTitle} />}
        />
      </InsetGroup>
      <ErrorBanner error={error} />
    </View>
  );
}

/** Which space the project is in; move it from the value menu. Hidden on computers without spaces. */
function SpaceRow({ projectId }: { projectId: string }) {
  const app = useApp();
  const spaces = useSpaces();
  const project = app.projects.find((item) => item.id === projectId);
  const current = spaces.spaces.find((item) => item.id === project?.space_id);
  const [error, setError] = useState("");
  if (!project || !spaces.supported || !current) return null;
  const items: MenuItem[] = spaces.spaces.map((target) => ({
    title: target.name,
    checked: target.id === current.id,
    onPress: () => {
      if (target.id === current.id) return;
      setError("");
      void moveProjectToSpace(project.id, target.id)
        .then(() => showToast(SPACE_COPY.movedToast(project.name, target.name)))
        .catch(() => setError(SPACE_COPY.moveFailure(project.name)));
    },
  }));
  return (
    <View>
      <SectionHeader title="Space" inset />
      <InsetGroup>
        <ListRow
          title={current.name}
          leading={<SpaceTile space={current} size={24} />}
          meta={current.is_default ? "Default" : undefined}
          value={spaces.spaces.length > 1 ? "Move" : undefined}
          valueMenu={spaces.spaces.length > 1 ? items : undefined}
        />
      </InsetGroup>
      <ErrorBanner error={error} />
    </View>
  );
}
