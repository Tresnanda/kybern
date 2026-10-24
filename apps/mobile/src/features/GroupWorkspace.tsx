// Thread setup for a group project: worktree or local, a base branch per
// repository ("main +2"), and in worktree mode which repositories the chat
// gets. Choices go into the draft for this project only (`GroupDraft`).
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { View } from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";
import {
  GROUP_COPY,
  deselectedNote,
  memberMissingLabel,
  reposChipLabel,
  uncommittedHint,
} from "../../../../packages/kybern-client/src/groups";
import type { DraftOptions } from "../state/draft";
import {
  availableMembers,
  baseBranchesSummary,
  groupDraftFor,
  includedPaths,
  isLastIncluded,
  toggleIncluded,
} from "../state/groups";
import type { BranchInfo, Project, ProjectsMembersStatusResult } from "../state/protocol";
import { rpc } from "../state/runtime";
import { CheckRow } from "../ui/CheckRow";
import { Group, Icon, Row, T, Tap, styles } from "../ui/primitives";
import { Toggle } from "../ui/Toggle";
import { useTheme } from "../ui/theme";

// Expanding a row moves the rows below it; one short layout transition keeps that legible.
const settle = LinearTransition.duration(220);

export function GroupWorkspace({
  project,
  options,
  patch,
}: {
  project: Project;
  options: DraftOptions;
  patch: (value: Partial<DraftOptions>) => void;
}) {
  const { colors } = useTheme();
  const [section, setSection] = useState<"" | "branches" | "repos">("");
  const [repoOpen, setRepoOpen] = useState("");
  const [branches, setBranches] = useState<Record<string, BranchInfo[]>>({});
  const [status, setStatus] = useState<ProjectsMembersStatusResult>();
  const [lastHint, setLastHint] = useState(false);
  const own = groupDraftFor(project, options);
  const available = availableMembers(project);
  const missing = (project.members ?? []).filter((member) => member.status !== "ok");
  const included = includedPaths(project, own);
  const worktree = options.worktree;
  const inUse = worktree ? available.filter((member) => included.includes(member.path)) : available;
  const current = Object.fromEntries((status?.members ?? []).map((member) => [member.path, member.branch]));
  useEffect(() => {
    let alive = true;
    void rpc("projects.members.status", { project_id: project.id })
      .then((result) => alive && setStatus(result))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [project.id]);
  function setOwn(value: Partial<typeof own>) {
    patch({ ...own, ...value, groupProjectId: project.id });
  }
  function openRepo(path: string) {
    const next = repoOpen === path ? "" : path;
    setRepoOpen(next);
    if (next && !branches[next])
      void rpc("git.branches", { project_id: project.id, repo: next })
        .then((result) => setBranches((all) => ({ ...all, [next]: result.branches })))
        .catch(() => setBranches((all) => ({ ...all, [next]: [] })));
  }
  const choice = (title: string, selected: boolean, onPress: () => void) => (
    <Tap
      key={title}
      label={title}
      selected={selected}
      onPress={onPress}
      style={[styles.spread, { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 13, backgroundColor: selected ? colors.raised : undefined }]}
    >
      <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
        {title}
      </T>
      {selected && <Icon name="checkmark" size={16} color={colors.accent} />}
    </Tap>
  );
  const deselected = available.filter((member) => !included.includes(member.path));
  return (
    <Group title="Workspace">
      <Animated.View layout={settle}>
        <Row
          title="Use a worktree"
          detail="Keep this thread’s changes in a separate checkout."
          icon="folder"
          trailing={
            <Toggle
              accessibilityLabel="Use a worktree"
              value={worktree}
              onValueChange={(value) => patch({ worktree: value })}
              trackColor={{ true: colors.accent }}
            />
          }
        />
      </Animated.View>
      <Animated.View layout={settle}>
        <Row
          title="Base branches"
          detail={baseBranchesSummary(inUse.map((member) => member.path), own.baseBranches, current)}
          icon="arrow.triangle.branch"
          onPress={() => setSection(section === "branches" ? "" : "branches")}
          trailing={<Icon name={section === "branches" ? "chevron.up" : "chevron.down"} size={13} color={colors.muted} />}
        />
        {section === "branches" && (
          <Animated.View entering={FadeIn.duration(160)} style={{ paddingStart: 35 }}>
            <T variant="footnote" tone="secondary" style={{ marginBottom: 4 }}>
              {worktree ? `${GROUP_COPY.branchMenuWorktreeTitle}:` : GROUP_COPY.branchMenuLocalCaption}
            </T>
            {inUse.map((member) => {
              const chosen = own.baseBranches[member.path];
              const now = current[member.path];
              return (
                <View key={member.path}>
                  <Tap
                    label={`${member.name}, ${chosen || now || "current branch"}`}
                    expanded={repoOpen === member.path}
                    onPress={() => openRepo(member.path)}
                    style={[styles.spread, { paddingVertical: 8 }]}
                  >
                    <T variant="label" style={{ flex: 1 }} numberOfLines={1}>
                      {member.name}
                      <T variant="footnote" tone="muted">{` · ${chosen || now || "Current branch"}`}</T>
                    </T>
                    <Icon name={repoOpen === member.path ? "chevron.up" : "chevron.down"} size={11} color={colors.muted} />
                  </Tap>
                  {repoOpen === member.path && (
                    <Animated.View entering={FadeIn.duration(160)}>
                      {choice(now ? `Current branch (${now})` : "Current branch", !chosen, () => {
                        const { [member.path]: _, ...rest } = own.baseBranches;
                        setOwn({ baseBranches: rest });
                        setRepoOpen("");
                      })}
                      {!branches[member.path] && (
                        <T variant="footnote" tone="secondary" style={{ padding: 12 }}>
                          Loading branches…
                        </T>
                      )}
                      {(branches[member.path] ?? []).map((branch) =>
                        choice(branch.name, chosen === branch.name, () => {
                          setOwn({ baseBranches: { ...own.baseBranches, [member.path]: branch.name } });
                          setRepoOpen("");
                        }),
                      )}
                    </Animated.View>
                  )}
                </View>
              );
            })}
          </Animated.View>
        )}
      </Animated.View>
      {worktree && (
        <Animated.View layout={settle}>
          <Row
            title={GROUP_COPY.repositories}
            detail={reposChipLabel(
              available.filter((member) => included.includes(member.path)).map((member) => member.name),
              available.length,
            )}
            icon="shippingbox"
            onPress={() => setSection(section === "repos" ? "" : "repos")}
            trailing={<Icon name={section === "repos" ? "chevron.up" : "chevron.down"} size={13} color={colors.muted} />}
          />
          {section === "repos" && (
            <Animated.View entering={FadeIn.duration(160)} style={{ paddingStart: 35 }}>
              {available.map((member) => {
                const live = status?.members.find((item) => item.path === member.path);
                const on = included.includes(member.path);
                return (
                  <CheckRow
                    key={member.path}
                    title={member.name}
                    titleDetail={own.baseBranches[member.path] || live?.branch || undefined}
                    detail={(on && uncommittedHint(live?.dirty_files ?? 0)) || undefined}
                    checked={on}
                    onToggle={() => {
                      if (isLastIncluded(project, own, member.path)) {
                        setLastHint(true);
                        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                        return;
                      }
                      setLastHint(false);
                      setOwn({ members: toggleIncluded(project, own, member.path) });
                    }}
                  />
                );
              })}
              {lastHint && (
                <T variant="footnote" tone="warning" accessibilityLiveRegion="polite">
                  {GROUP_COPY.lastRepository}
                </T>
              )}
              {!!deselected.length && (
                <T variant="footnote" tone="secondary" style={{ marginTop: 2 }}>
                  {deselectedNote(deselected, (member) => `${project.path}/${member.path}`)}
                </T>
              )}
            </Animated.View>
          )}
        </Animated.View>
      )}
      {missing.map((member) => (
        <T key={member.path} variant="footnote" tone="warning">
          {`${member.name}: ${memberMissingLabel(project.path)}. New chats skip it.`}
        </T>
      ))}
    </Group>
  );
}
