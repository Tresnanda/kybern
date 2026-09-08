import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
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
import { errorText, rpc } from "../state/runtime";
import { Icon, T, Tap, styles } from "../ui/primitives";
import { useTheme } from "../ui/theme";

export function ComposerSuggestions({
  trigger,
  projectId,
  provider,
  commands,
  actions,
  onAction,
  onPick,
  onDismiss,
}: {
  trigger: ComposerTrigger;
  projectId: string;
  provider: ProviderKind;
  commands: ProviderCommand[];
  actions: { name: string; description: string }[];
  onAction: (name: string) => void;
  onPick: (part: ContentPart) => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setSkills([]);
    setSkillsLoading(true);
    if (!projectId) {
      setSkillsLoading(false);
      return;
    }
    void rpc("skills.list", { project_id: projectId, provider })
      .then((r) => {
        if (alive) {
          setSkills(r.skills.filter((s) => s.enabled));
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
  }, [projectId, provider]);
  useEffect(() => {
    let alive = true;
    setFiles([]);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      if (trigger.marker !== "@" || !projectId) {
        setLoading(false);
        return;
      }
      void rpc("files.search", {
        project_id: projectId,
        query: trigger.query,
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
  }, [projectId, trigger.marker, trigger.query]);
  const query = trigger.query.toLowerCase();
  const matches = (s: string) => s.toLowerCase().includes(query);
  const rows: {
    id: string;
    title: string;
    detail: string;
    part?: ContentPart;
    action?: string;
  }[] = [
    ...(trigger.marker === "/"
      ? actions
          .filter((a) => matches(a.name + " " + a.description))
          .map((a) => ({
            id: `action:${a.name}`,
            title: `/${a.name}`,
            detail: a.description,
            action: a.name,
          }))
      : []),
    ...(trigger.marker === "/"
      ? commands
          .filter((c) => matches(c.name + " " + c.description))
          .map((c) => ({
            id: `command:${c.name}`,
            title: `/${actions.some((a) => a.name === c.name) ? "harness:" : ""}${c.name.replace(/^\//, "")}`,
            detail: c.description,
            part: { type: "text" as const, text: commandText(c.name) },
          }))
      : []),
    ...skills
      .filter(
        (s) =>
          (trigger.marker === "@"
            ? s.scope === "plugin"
            : s.scope !== "plugin") &&
          matches(`${s.name} ${s.display_name ?? ""} ${s.description}`),
      )
      .map((s) => ({
        id: s.path,
        title: s.display_name || s.name,
        detail: s.scope === "plugin" ? "Plugin" : s.description || "Skill",
        part: capabilityPart(s),
      })),
    ...files.map((path) => ({
      id: `file:${path}`,
      title: path,
      detail: "Project file",
      part: { type: "file_mention" as const, path },
    })),
  ];
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 22,
        padding: 8,
        boxShadow: "0 4px 24px #00000020",
        borderWidth: 1,
        borderColor: colors.line,
      }}
    >
      <View style={[styles.spread, { paddingStart: 10 }]}>
        <T variant="caption" tone="secondary">
          {trigger.marker === "@"
            ? "Files & plugins"
            : trigger.marker === "/"
              ? "Commands & skills"
              : "Skills"}
        </T>
        <Tap label="Dismiss suggestions" onPress={onDismiss}>
          <Icon name="xmark" size={12} />
        </Tap>
      </View>
      <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 210 }}>
        {rows.map((row) => (
          <Tap
            key={row.id}
            label={`${row.action ? "Run" : "Add"} ${row.title}`}
            static
            onPress={() =>
              row.action ? onAction(row.action) : row.part && onPick(row.part)
            }
            style={[styles.line, { paddingHorizontal: 10, paddingVertical: 8 }]}
          >
            <Icon
              name={
                row.part?.type === "file_mention"
                  ? "doc.text"
                  : row.part?.type === "mention"
                    ? "puzzlepiece.extension"
                    : row.action || row.part?.type === "text"
                      ? "command"
                      : "sparkles"
              }
              size={17}
            />
            <View style={{ flex: 1 }}>
              <T variant="label" numberOfLines={2}>
                {row.title}
              </T>
              <T variant="caption" tone="secondary" numberOfLines={2}>
                {row.detail}
              </T>
            </View>
          </Tap>
        ))}
        {!rows.length && (
          <T variant="caption" tone="secondary" style={{ padding: 12 }}>
            {error ||
              (loading || skillsLoading
                ? "Loading suggestions…"
                : !projectId
                  ? "Choose a project to find files and skills."
                  : "No matches. Try another name.")}
          </T>
        )}
      </ScrollView>
    </View>
  );
}
