// The Repositories section on a group project's page: members with their live
// state, removing one (with Undo), adding more, the shared AGENTS.md / CLAUDE.md
// the group folder offers (P2-10), and the top-level entries copied into each
// new worktree. Members can never drop below the minimum.
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import {
  GROUP_COPY,
  canRemoveMember,
  instructionsCreatedText,
  instructionsOfferBody,
  memberMissingError,
  memberMissingLabel,
  memberNotGitError,
  repoBadge,
  uncommittedHint,
} from "../../../../packages/kybern-client/src/groups";
import { toggleCopyEntry } from "../state/groups";
import type { Project, ProjectsMembersStatusResult } from "../state/protocol";
import { errorText, refresh, rpc } from "../state/runtime";
import { Alert, confirm } from "../ui/Alert";
import { CheckRow } from "../ui/CheckRow";
import { DisclosureRow, InsetGroup, ListRow, SectionFooter, SectionHeader } from "../ui/List";
import { ErrorBanner, T } from "../ui/primitives";
import { radius, space, useTheme } from "../ui/theme";
import { showToast } from "../ui/Toast";

/** "3 repos" next to a group project's name in lists. */
export function RepoBadge({ count }: { count: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ paddingHorizontal: space.sm, paddingVertical: space["2xs"], borderRadius: radius.full, backgroundColor: colors.raised }}>
      <T variant="caption" tone="secondary" style={{ fontWeight: "500", fontVariant: ["tabular-nums"] }}>
        {repoBadge(count)}
      </T>
    </View>
  );
}

/** Which shared instruction files the group folder lacks. */
export function missingInstructions(status: { agents_md: boolean; claude_md: boolean } | null | undefined): string[] {
  if (!status) return [];
  return [...(status.agents_md ? [] : ["AGENTS.md"]), ...(status.claude_md ? [] : ["CLAUDE.md"])];
}

export function GroupRepositories({ project, onChanged }: { project: Project; onChanged: (project: Project) => void }) {
  const [state, setState] = useState<ProjectsMembersStatusResult>();
  const [copyOpen, setCopyOpen] = useState(false);
  const [copy, setCopy] = useState<string[]>(project.worktree_copy ?? []);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const members = project.members ?? [];
  const memberKey = members.map((member) => member.path).join("\n");
  const load = () =>
    rpc("projects.members.status", { project_id: project.id })
      .then(setState)
      .catch((e) => setError(errorText(e)));
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

  async function setMembers(paths: string[]) {
    const next = await rpc("projects.update", { project_id: project.id, members: paths });
    onChanged(next);
    void refresh();
  }
  function remove(path: string, name: string) {
    const before = members.map((member) => member.path);
    setError("");
    void setMembers(before.filter((item) => item !== path))
      .then(() =>
        showToast(GROUP_COPY.removed(name), {
          title: GROUP_COPY.undo,
          onPress: () => void setMembers(before).catch((e) => setError(errorText(e))),
        }),
      )
      .catch((e) => setError(errorText(e)));
  }
  function explain(name: string, status: string) {
    const message =
      status === "missing" ? memberMissingError(name, project.path) : status === "not_git" ? memberNotGitError(name) : GROUP_COPY.minimumReason;
    Alert.alert(name, message, [{ text: "OK", style: "cancel" }]);
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
  const missing = missingInstructions(state);
  function createInstructions() {
    confirm({
      title: GROUP_COPY.instructionsOfferTitle,
      message: instructionsOfferBody(project.name, members.map((m) => m.name), missing, project.is_git),
      confirm: GROUP_COPY.createFiles,
      destructive: false,
      onConfirm: () => {
        setCreating(true);
        setError("");
        void rpc("projects.instructions.create", { project_id: project.id })
          .then((result) => {
            showToast(instructionsCreatedText(result.created, project.name));
            return load();
          })
          .catch((e) => setError(errorText(e)))
          .finally(() => setCreating(false));
      },
    });
  }

  const memberRoots = new Set(members.map((member) => member.path.split("/")[0]));
  const candidates = (state?.copy_candidates ?? []).filter((entry) => !memberRoots.has(entry.name) && entry.name !== ".git");
  const absent = copy.filter((name) => !candidates.some((entry) => entry.name === name));
  const removable = canRemoveMember(members.length);
  return (
    <>
      <SectionHeader title={GROUP_COPY.repositories} count={members.length} inset />
      <ErrorBanner error={error} />
      <InsetGroup>
        {members.map((member, index) => {
          const live = state?.members.find((item) => item.path === member.path);
          const status = live?.status ?? member.status;
          const ok = status === "ok";
          const detail = !ok
            ? status === "missing"
              ? memberMissingLabel(project.path)
              : "Not a git repository anymore"
            : [member.path !== member.name ? member.path : "", live?.branch ?? "", uncommittedHint(live?.dirty_files ?? 0) ?? ""]
                .filter(Boolean)
                .join(" · ") || undefined;
          return (
            <ListRow
              key={member.path}
              title={member.name}
              subtitle={detail}
              subtitleLines={1}
              leading={ok ? "shippingbox" : "exclamationmark.triangle"}
              meta={index === 0 ? GROUP_COPY.primary : undefined}
              onPress={ok ? undefined : () => explain(member.name, status)}
              menu={[
                removable
                  ? { title: GROUP_COPY.removeFromGroup, icon: "minus.circle", destructive: true, onPress: () => remove(member.path, member.name) }
                  : { title: GROUP_COPY.removeFromGroup, icon: "minus.circle", disabled: true, subtitle: GROUP_COPY.minimumReason },
              ]}
            />
          );
        })}
        <ListRow
          title={GROUP_COPY.addRepositories}
          leading="plus"
          onPress={() => router.push({ pathname: "/add-project", params: { projectId: project.id } })}
        />
      </InsetGroup>
      <SectionFooter inset>{"Touch and hold a repository to remove it. Existing chats keep theirs."}</SectionFooter>

      <SectionHeader title={GROUP_COPY.sharedInstructions} inset />
      <InsetGroup>
        <ListRow
          title={missing.length ? GROUP_COPY.notSetUp : "AGENTS.md and CLAUDE.md"}
          subtitle={missing.length ? GROUP_COPY.notSetUpDetail(project.name) : `In ${project.name}. Kybern never edits them after creating them.`}
          leading="doc.text"
          value={missing.length ? (creating ? GROUP_COPY.creating : GROUP_COPY.createFilesEllipsis) : undefined}
          disabled={!state || creating}
          onPress={missing.length ? createInstructions : undefined}
        />
      </InsetGroup>

      <SectionHeader title={GROUP_COPY.alsoCopy} inset />
      <InsetGroup>
        <View style={{ minHeight: 44, justifyContent: "center" }}>
          <DisclosureRow
            title={copy.length ? copy.join(", ") : GROUP_COPY.alsoCopyEmpty}
            open={copyOpen}
            onToggle={() => setCopyOpen(!copyOpen)}
          />
        </View>
        {copyOpen ? (
          <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
            {!state ? <T variant="footnote" tone="secondary">{`Loading ${project.name}…`}</T> : null}
            {state && !candidates.length && !absent.length ? (
              <T variant="footnote" tone="secondary">{`Nothing else in ${project.name} can be copied.`}</T>
            ) : null}
            {candidates.map((entry) => (
              <CheckRow
                key={entry.name}
                title={entry.is_dir ? `${entry.name}/` : entry.name}
                checked={copy.includes(entry.name)}
                onToggle={() => toggleCopy(entry.name)}
              />
            ))}
            {state
              ? absent.map((name) => (
                  <CheckRow key={name} title={name} detail={`Not in ${project.name} now, so it’s skipped.`} checked onToggle={() => toggleCopy(name)} />
                ))
              : null}
          </View>
        ) : null}
      </InsetGroup>
      <SectionFooter inset>{GROUP_COPY.alsoCopyDetail(project.name)}</SectionFooter>
    </>
  );
}
