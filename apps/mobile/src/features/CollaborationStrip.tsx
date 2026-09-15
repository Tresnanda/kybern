import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { shouldReloadCollaboration } from "../../../../packages/kybern-client/src/collaboration";
import type {
  AssignmentStatus,
  CollaborationGroupDetail,
  Thread,
  ThreadEvent,
} from "../state/protocol";
import {
  rpc,
  subscribeCollaboration,
  useApp,
} from "../state/runtime";
import { Icon, T, Tap, styles } from "../ui/primitives";
import { ProviderMark } from "../ui/ProviderMark";
import { useTheme } from "../ui/theme";

const live = new Set<AssignmentStatus>([
  "pending",
  "working",
  "waiting",
  "blocked",
  "attention_needed",
]);

function statusLabel(status: AssignmentStatus) {
  if (status === "attention_needed") return "Needs attention";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function CollaborationStrip({ thread }: { thread?: Thread | null }) {
  const app = useApp();
  const { colors } = useTheme();
  const [detail, setDetail] = useState<CollaborationGroupDetail | null>(null);
  const generation = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const load = useCallback(async () => {
    if (!thread?.collaboration_group_id) {
      setDetail(null);
      return;
    }
    const current = ++generation.current;
    try {
      const candidate = await rpc("collaboration.groups.get", {
        group_id: thread.collaboration_group_id,
      });
      if (current === generation.current) setDetail(candidate);
    } catch {
      if (current === generation.current) setDetail(null);
    }
  }, [thread?.collaboration_group_id, app.activeId]);

  useEffect(() => {
    setDetail(null);
    setExpanded(false);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeCollaboration((event: ThreadEvent | null) => {
      if (
        !shouldReloadCollaboration(
          event,
          thread?.collaboration_group_id ?? null,
        )
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), event ? 80 : 0);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [thread?.collaboration_group_id, load]);

  const helpers = useMemo(() => {
    if (!detail) return [];
    return detail.assignments
      .filter(
        (assignment) =>
          assignment.owner_thread_id && live.has(assignment.status),
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((assignment) => ({
        assignment,
        thread: app.threads.find(
          (item) => item.id === assignment.owner_thread_id,
        ),
      }));
  }, [detail, app.threads]);
  if (!thread || (!detail && !thread.parent_thread_id && !thread.coordinator_project_id)) return null;

  const mainId =
    detail?.group.coordinator_thread_id ?? thread.parent_thread_id;
  const main = app.threads.find((item) => item.id === mainId);
  const attentionCount = helpers.filter(({ assignment }) => ["blocked", "attention_needed"].includes(assignment.status)).length;
  const pill = {
    minHeight: 48,
    borderRadius: 20,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    gap: 7,
  } as const;
  return (
    <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 20 }}>
      <Tap label={`${expanded ? "Hide" : "Show"} helpers`} expanded={expanded} static
        onPress={() => setExpanded(value => !value)} style={[styles.line, { minHeight: 48, gap: 8 }]}>
        <Icon name="person.2" size={18} />
        <T variant="caption" style={{ flex: 1 }}>{thread.coordinator_project_id && detail?.coordinator_setup_complete === false ? "Project setup" : `${detail?.members.filter(member => member.thread_id !== mainId && member.active).length ?? helpers.length} helpers`}</T>
        {helpers.length > 0 && <T variant="caption" tone="secondary">{attentionCount > 0 ? `${attentionCount} need attention` : `${helpers.length} active`}</T>}
        <Icon name={expanded ? "chevron.up" : "chevron.down"} size={12} />
      </Tap>
      {expanded && <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 240 }} contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
      {thread.coordinator_project_id && detail?.coordinator_setup_complete === false && <Tap
        label="Project setup: view research progress"
        onPress={() => router.push({ pathname: "/collaboration", params: { threadId: thread.id } })}
        style={[styles.line, pill]}
      ><T variant="caption">Project setup</T></Tap>}
      {mainId && mainId !== thread.id && (
        <Tap
          label={`Back to main conversation${main?.title ? `, ${main.title}` : ""}`}
          onPress={() =>
            router.dismissTo({
              pathname: "/thread/[id]",
              params: { id: mainId },
            })
          }
          style={[styles.line, pill]}
        >
          <Icon name="arrow.turn.up.left" size={15} />
          <T variant="caption" numberOfLines={1} style={{ maxWidth: 150 }}>
            Main
          </T>
        </Tap>
      )}
      {helpers.map(({ assignment, thread: helper }) => (
        <Tap
          key={assignment.id}
          label={`Open ${helper?.title || assignment.title}, ${statusLabel(assignment.status)}`}
          disabled={!helper}
          onPress={() =>
            helper &&
            router.push({ pathname: "/thread/[id]", params: { id: helper.id } })
          }
          style={[styles.line, pill]}
        >
          {helper ? (
            <ProviderMark kind={helper.provider.kind} size={15} />
          ) : (
            <Icon name="person.crop.circle" size={15} />
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <T variant="caption" numberOfLines={2}>
              {helper?.title || assignment.title}
            </T>
            <T variant="caption" tone="secondary" numberOfLines={1}>
              {statusLabel(assignment.status)}
            </T>
          </View>
        </Tap>
      ))}
      {(detail || thread.coordinator_project_id) && (
        <Tap
          label="Open all agents and collaboration details"
          onPress={() =>
            router.push({
              pathname: "/collaboration",
              params: { threadId: thread.id },
            })
          }
          style={[styles.line, pill]}
        >
          <Icon name="person.2" size={15} />
          <T variant="caption">{thread.coordinator_project_id ? "Workers" : "All agents"}</T>
        </Tap>
      )}
      {thread.coordinator_project_id && ([
        { view: "context", label: "Project knowledge", icon: "doc.text" as const },
        { view: "results", label: "Results", icon: "checkmark" as const },
      ]).map((item) => (
        <Tap key={item.view} label={`Open ${item.label.toLowerCase()}`}
          onPress={() => router.push({ pathname: "/collaboration", params: { threadId: thread.id, view: item.view } })}
          style={[styles.line, pill]}>
          <Icon name={item.icon} size={15} />
          <T variant="caption">{item.label}</T>
        </Tap>
      ))}
    </ScrollView>}
    </View>
  );
}
