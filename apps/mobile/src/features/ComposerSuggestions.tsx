// The composer's completion panel. `/` lists actions, commands and skills; `$` skills;
// `@` threads, notes, tasks, files and plugins, with a filter at the top and typed
// prefixes (`@note:login`, `@task:ADE-12`, `@thread:`) as on the desktop (parity P2-6).
import { useEffect, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { threadReferencePart } from "../../../../packages/kybern-client/src/threadReferences";
import { noteMentionPart, taskMentionPart } from "../../../../packages/kybern-client/src/userInput";
import { isChildThread } from "../../../../packages/kybern-client/src/subagents";
import {
  capabilityPart,
  commandText,
  type ComposerTrigger,
} from "../state/capabilities";
import type {
  ContentPart,
  ProviderCommand,
  ProviderKind,
  SkillInfo,
} from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import { useNotes } from "../state/notes";
import { useTasks } from "../state/tasks";
import { InsetGroup, ListRow } from "../ui/List";
import { Segmented } from "../ui/Segmented";
import type { IconName } from "../ui/icons";
import { IconButton, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";

type MentionFilter = "all" | "thread" | "note" | "task" | "file";
const PREFIXES: Record<string, Exclude<MentionFilter, "all"> | "plugin"> = {
  thread: "thread",
  threads: "thread",
  note: "note",
  notes: "note",
  task: "task",
  tasks: "task",
  file: "file",
  files: "file",
  plugin: "plugin",
  plugins: "plugin",
};
/** `note:login` → notes matching "login"; anything else searches every kind. */
function parseQuery(query: string) {
  const match = /^([a-z]+):/i.exec(query);
  const kind = match ? PREFIXES[match[1]!.toLowerCase()] : undefined;
  return kind ? { kind, term: query.slice(match![0].length) } : { kind: null, term: query };
}
/** Under All, a few of each kind; a filter shows its kind's full list. */
const PER_KIND = 3;
const LIMIT = 20;

type Row = {
  id: string;
  kind: "action" | "command" | "skill" | "plugin" | "thread" | "note" | "task" | "file";
  title: string;
  detail: string;
  part?: ContentPart;
  action?: string;
};
const ICONS: Record<Row["kind"], IconName> = {
  action: "command",
  command: "command",
  skill: "sparkles",
  plugin: "puzzlepiece.extension",
  thread: "text.bubble",
  note: "square.and.pencil",
  task: "checklist",
  file: "doc.text",
};

export function ComposerSuggestions({
  trigger,
  projectId,
  provider,
  instance,
  threadId,
  commands,
  actions,
  onAction,
  onPick,
  onDismiss,
  onCatalog,
}: {
  trigger: ComposerTrigger;
  projectId: string;
  provider: ProviderKind;
  instance?: string;
  /** The thread being written in: it never suggests itself. */
  threadId?: string;
  commands: ProviderCommand[];
  actions: { name: string; description: string }[];
  onAction: (name: string) => void;
  onPick: (part: ContentPart) => void;
  onDismiss: () => void;
  onCatalog: (skills: SkillInfo[]) => void;
}) {
  const { colors } = useTheme();
  const app = useApp();
  const notes = useNotes();
  const tasks = useTasks();
  const [filter, setFilter] = useState<MentionFilter>("all");
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mention = trigger.marker === "@";
  const parsed = mention ? parseQuery(trigger.query) : { kind: null, term: trigger.query };
  const kind = parsed.kind ?? (filter === "all" ? null : filter);
  useEffect(() => {
    let alive = true;
    setSkills([]);
    setSkillsLoading(true);
    if (!projectId) {
      setSkillsLoading(false);
      return;
    }
    void rpc("skills.list", { project_id: projectId, provider, instance })
      .then((r) => {
        if (alive) {
          setSkills(r.skills.filter((s) => s.enabled));
          onCatalog(r.skills);
          setSkillsLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(errorText(e));
          setSkillsLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, provider, instance, onCatalog]);
  const wantsFiles = mention && (kind === null || kind === "file");
  useEffect(() => {
    let alive = true;
    setFiles([]);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      if (!wantsFiles || !projectId) {
        setLoading(false);
        return;
      }
      void rpc("files.search", {
        project_id: projectId,
        query: parsed.term,
        limit: 30,
      })
        .then((r) => {
          if (alive) setFiles(r.files);
        })
        .catch((e) => {
          if (alive) setError(errorText(e));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, wantsFiles, parsed.term]);
  const term = parsed.term.toLowerCase();
  const matches = (s: string) => s.toLowerCase().includes(term);
  const rows = useMemo(() => {
    const take = (list: Row[], k: Row["kind"]) =>
      list.slice(0, kind === null && mention ? PER_KIND : kind === k || !mention ? LIMIT : 0);
    if (!mention)
      return [
        ...(trigger.marker === "/"
          ? actions
              .filter((a) => matches(a.name + " " + a.description))
              .map((a): Row => ({ id: `action:${a.name}`, kind: "action", title: `/${a.name}`, detail: a.description, action: a.name }))
          : []),
        ...(trigger.marker === "/"
          ? commands
              .filter((c) => matches(c.name + " " + c.description))
              .map((c): Row => ({
                id: `command:${c.name}`,
                kind: "command",
                title: `/${actions.some((a) => a.name === c.name) ? "harness:" : ""}${c.name.replace(/^\//, "")}`,
                detail: c.description,
                part: { type: "text", text: commandText(c.name) },
              }))
          : []),
        ...skills
          .filter((s) => s.scope !== "plugin" && matches(`${s.name} ${s.display_name ?? ""} ${s.description}`))
          .map((s): Row => ({ id: s.path, kind: "skill", title: s.display_name || s.name, detail: s.description || "Skill", part: capabilityPart(s) })),
      ];
    const threads: Row[] = app.threads
      .filter((t) => t.id !== threadId && t.status !== "archived" && !isChildThread(t) && matches(t.title))
      .map((t) => ({
        id: `thread:${t.id}`,
        kind: "thread",
        title: t.title || "Untitled thread",
        detail: app.projects.find((p) => p.id === t.project_id)?.name ?? "Thread",
        part: threadReferencePart(t),
      }));
    const noteRows: Row[] = notes.notes
      .filter((n) => !n.deleted_at && (matches(n.title) || matches(n.preview)))
      .sort((a, b) => Number(b.project_id === projectId) - Number(a.project_id === projectId))
      .map((n) => ({
        id: `note:${n.id}`,
        kind: "note",
        title: n.title || "Untitled note",
        detail: n.preview.split("\n").find((line) => line.trim())?.trim() || "Note",
        part: noteMentionPart(n),
      }));
    const taskRows: Row[] = tasks.tasks
      .filter((t) => matches(`${t.key} ${t.title}`))
      .sort((a, b) => {
        const closed = (s: string) => Number(s === "done" || s === "canceled");
        return closed(a.status) - closed(b.status);
      })
      .map((t) => ({ id: `task:${t.id}`, kind: "task", title: t.title || "Untitled task", detail: t.key, part: taskMentionPart(t) }));
    const fileRows: Row[] = files.map((path) => ({ id: `file:${path}`, kind: "file", title: path, detail: "Project file", part: { type: "file_mention", path } }));
    const plugins: Row[] = skills
      .filter((s) => s.scope === "plugin" && matches(`${s.name} ${s.display_name ?? ""} ${s.description}`))
      .map((s) => ({ id: s.path, kind: "plugin", title: s.display_name || s.name, detail: "Plugin", part: capabilityPart(s) }));
    return [
      ...take(threads, "thread"),
      ...take(noteRows, "note"),
      ...take(taskRows, "task"),
      ...take(fileRows, "file"),
      ...(kind === null || kind === ("plugin" as string) ? plugins.slice(0, kind === null ? PER_KIND : LIMIT) : []),
    ];
  }, [mention, trigger.marker, actions, commands, skills, files, app.threads, app.projects, notes.notes, tasks.tasks, kind, term, threadId, projectId]);
  return (
    <View
      style={{
        backgroundColor: colors.grouped,
        borderRadius: radius.lg,
        padding: 6,
        boxShadow: "0 4px 24px #00000020",
        borderWidth: 0.5,
        borderColor: colors.line,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, paddingStart: space.sm }}>
        <View style={{ flex: 1 }}>
          {mention && !parsed.kind ? (
            <Segmented
              compact
              label="Mention"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "thread", label: "Threads" },
                { value: "note", label: "Notes" },
                { value: "task", label: "Tasks" },
                { value: "file", label: "Files" },
              ]}
            />
          ) : (
            <T variant="sectionHeader" tone="secondary">
              {mention ? `Mention a ${parsed.kind}` : trigger.marker === "/" ? "Commands and skills" : "Skills"}
            </T>
          )}
        </View>
        <IconButton name="xmark" size={14} label="Dismiss suggestions" onPress={onDismiss} />
      </View>
      <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 232, borderRadius: radius.md }}>
        {rows.length ? (
          <InsetGroup>
            {rows.map((row) => (
              <ListRow
                key={row.id}
                title={row.title}
                subtitle={row.detail}
                subtitleLines={1}
                mono={row.kind === "file" || row.kind === "action" || row.kind === "command"}
                leading={ICONS[row.kind]}
                label={`${row.action ? "Run" : "Add"} ${row.title}`}
                onPress={() => (row.action ? onAction(row.action) : row.part && onPick(row.part))}
              />
            ))}
          </InsetGroup>
        ) : (
          <T variant="footnote" tone="secondary" style={{ padding: space.md }}>
            {error ||
              (loading || skillsLoading
                ? "Loading suggestions…"
                : !projectId && wantsFiles
                  ? "Choose a project to find files and skills."
                  : "No matches. Try another name.")}
          </T>
        )}
      </ScrollView>
    </View>
  );
}
