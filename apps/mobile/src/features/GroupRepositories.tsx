// The Repositories group on a group project's page: members with their live
// state, removing one (with Undo), adding more, and the top-level entries
// copied into each new worktree. Members can never drop below the minimum.
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import {
  GROUP_COPY,
  canRemoveMember,
  memberMissingError,
  memberMissingLabel,
  memberNotGitError,
  repoBadge,
  uncommittedHint,
} from "../../../../packages/kybern-client/src/groups";
import { toggleCopyEntry } from "../state/groups";
import type { Project, ProjectsMembersStatusResult } from "../state/protocol";
import { errorText, refresh, rpc } from "../state/runtime";
import { Alert } from "../ui/Alert";
import { CheckRow } from "../ui/CheckRow";
import { ErrorBanner, Group, Icon, Row, T, Tap, styles } from "../ui/primitives";
import { radius, useTheme } from "../ui/theme";

/** "3 repos" next to a group project's name in lists. */
export function RepoBadge({ count }: { count: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full, backgroundColor: colors.raised }}>
      <T variant="caption" tone="secondary" style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }}>
        {repoBadge(count)}
      </T>
    </View>
  );
}

export function GroupRepositories({ project, onChanged }: { project: Project; onChanged: (project: Project) => void }) {
  const { colors } = useTheme();
  const [state, setState] = useState<ProjectsMembersStatusResult>();
  const [copyOpen, setCopyOpen] = useState(false);
  const [copy, setCopy] = useState<string[]>(project.worktree_copy ?? []);
  const [removed, setRemoved] = useState<{ name: string; members: string[]; after: string } | null>(null);
  const [error, setError] = useState("");
  const members = project.members ?? [];
  const memberKey = members.map((member) => member.path).join("\n");
  useEffect(() => {
    let alive = true;
    void rpc("projects.members.status", { project_id: project.id })
      .then((result) => alive && setState(result))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [project.id, memberKey]);
  useEffect(() => setCopy(project.worktree_copy ?? []), [project.id, (project.worktree_copy ?? []).join("\n")]);
  // Undo only restores the list it removed from; any other change to the members retires it.
  useEffect(() => {
    if (removed && memberKey !== removed.after) setRemoved(null);
  }, [memberKey]);

  async function setMembers(paths: string[]) {
    const next = await rpc("projects.update", { project_id: project.id, members: paths });
    onChanged(next);
    void refresh();
  }
  function remove(path: string, name: string) {
    const before = members.map((member) => member.path);
    setError("");
    const after = before.filter((item) => item !== path);
    void setMembers(after)
      .then(() => setRemoved({ name, members: before, after: after.join("\n") }))
      .catch((e) => setError(errorText(e)));
  }
  function actions(path: string, name: string, status: string) {
    const removable = canRemoveMember(members.length);
    const message =
      status === "missing"
        ? memberMissingError(name, project.path)
        : status === "not_git"
          ? memberNotGitError(name)
          : removable
            ? "Existing chats keep it. Its worktrees stay until those chats are archived."
            : GROUP_COPY.minimumReason;
    Alert.alert(
      name,
      message,
      removable
        ? [
            { text: GROUP_COPY.cancel, style: "cancel" },
            { text: GROUP_COPY.removeFromGroup, style: "destructive", onPress: () => remove(path, name) },
          ]
        : [{ text: "OK", style: "cancel" }],
    );
  }
  function toggleCopy(name: string) {
    const before = copy;
    const next = toggleCopyEntry(copy, name);
    setCopy(next);
    setError("");
    void rpc("projects.update", { project_id: project.id, worktree_copy: next })
      .then((updated) => {
        onChanged(updated);
        void refresh();
      })
      .catch((e) => {
        setCopy(before);
        setError(errorText(e));
      });
  }

  const memberRoots = new Set(members.map((member) => member.path.split("/")[0]));
  const candidates = (state?.copy_candidates ?? []).filter((entry) => !memberRoots.has(entry.name) && entry.name !== ".git");
  const absent = copy.filter((name) => !candidates.some((entry) => entry.name === name));
  return (
    <Group title={GROUP_COPY.repositories}>
      <ErrorBanner error={error} />
      {members.map((member, index) => {
        const live = state?.members.find((item) => item.path === member.path);
        const status = live?.status ?? member.status;
        const detail =
          status === "missing"
            ? memberMissingLabel(project.path)
            : status === "not_git"
              ? "Not a git repository anymore"
              : [member.path !== member.name ? member.path : "", live?.branch ?? "", uncommittedHint(live?.dirty_files ?? 0) ?? ""]
                  .filter(Boolean)
                  .join(" · ") || undefined;
        return (
          <Tap
            key={member.path}
            label={`${member.name}${index === 0 ? `, ${GROUP_COPY.primary.toLowerCase()}` : ""}, ${detail ?? ""}`}
            onPress={() => actions(member.path, member.name, status)}
            onLongPress={() => actions(member.path, member.name, status)}
          >
            <View style={[styles.line, { gap: 14, paddingVertical: 12 }]}>
              <Icon name={status === "ok" ? "shippingbox" : "exclamationmark.triangle"} color={status === "ok" ? colors.secondary : colors.warning} />
              <View style={{ flex: 1, gap: 3 }}>
                <T variant="label">{member.name}</T>
                {detail && (
                  <T variant="footnote" tone={status === "ok" ? "secondary" : "warning"}>
                    {detail}
                  </T>
                )}
              </View>
              {index === 0 && (
                <T variant="footnote" tone="muted">
                  {GROUP_COPY.primary}
                </T>
              )}
            </View>
          </Tap>
        );
      })}
      {removed && (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={[styles.spread, { paddingVertical: 4 }]} accessibilityLiveRegion="polite">
          <T variant="footnote" tone="secondary" style={{ flex: 1 }}>
            {GROUP_COPY.removed(removed.name)}
          </T>
          <Tap
            label={`${GROUP_COPY.undo} removing ${removed.name}`}
            onPress={() => {
              const previous = removed.members;
              setRemoved(null);
              void setMembers(previous).catch((e) => setError(errorText(e)));
            }}
          >
            <T variant="label" tone="accent">
              {GROUP_COPY.undo}
            </T>
          </Tap>
        </Animated.View>
      )}
      <Row
        title={GROUP_COPY.addRepositories}
        icon="plus"
        onPress={() => router.push({ pathname: "/add-project", params: { projectId: project.id } })}
      />
      <Row
        title={GROUP_COPY.alsoCopy}
        detail={copy.length ? copy.join(", ") : GROUP_COPY.alsoCopyEmpty}
        detailLines={2}
        icon="doc.on.doc"
        onPress={() => setCopyOpen(!copyOpen)}
        trailing={<Icon name={copyOpen ? "chevron.up" : "chevron.down"} size={13} color={colors.muted} />}
      />
      {copyOpen && (
        <Animated.View entering={FadeIn.duration(160)} style={{ paddingStart: 35 }}>
          <T variant="footnote" tone="secondary" style={{ marginBottom: 4 }}>
            {GROUP_COPY.alsoCopyDetail(project.name)}
          </T>
          {!state && (
            <T variant="footnote" tone="secondary">
              Loading {project.name}…
            </T>
          )}
          {state && !candidates.length && !absent.length && (
            <T variant="footnote" tone="secondary">
              Nothing else in {project.name} can be copied.
            </T>
          )}
          {candidates.map((entry) => (
            <CheckRow
              key={entry.name}
              title={entry.is_dir ? `${entry.name}/` : entry.name}
              checked={copy.includes(entry.name)}
              onToggle={() => toggleCopy(entry.name)}
            />
          ))}
          {state &&
            absent.map((name) => (
              <CheckRow
                key={name}
                title={name}
                detail={`Not in ${project.name} now, so it’s skipped.`}
                checked
                onToggle={() => toggleCopy(name)}
              />
            ))}
        </Animated.View>
      )}
    </Group>
  );
}
