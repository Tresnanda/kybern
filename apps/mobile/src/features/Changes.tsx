import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import { Alert } from "../ui/Alert";
import { type Diff, type GitStatus } from "../state/protocol";
import { errorText, rpc, useApp } from "../state/runtime";
import {
  changedReposLabel,
  commitDetail,
  groupFilesByRepo,
  includedMembers,
  prButtonLabel,
  prCaption,
  prResultToast,
  stripRepoPrefix,
  type MemberLike,
  type RepoFileGroup,
} from "../../../../packages/kybern-client/src/groups";
import { prPlan, repoPullRows } from "../state/groups";
import { Code } from "../ui/Markdown";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  Group,
  Icon,
  Row,
  T,
  Tap,
  styles,
} from "../ui/primitives";
import { useTheme } from "../ui/theme";
import { Working } from "../ui/Working";

export function Changes({ threadId }: { threadId: string }) {
  const { colors } = useTheme();
  const thread = useApp().threads.find((t) => t.id === threadId);
  const [diff, setDiff] = useState<Diff>();
  const [status, setStatus] = useState<GitStatus>();
  const [selected, setSelected] = useState("");
  const [patch, setPatch] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function reload() {
    setBusy(true);
    try {
      const [d, s] = await Promise.all([
        rpc("threads.diff", { thread_id: threadId, include_patch: false }),
        rpc("git.status", { thread_id: threadId }),
      ]);
      setDiff(d);
      setStatus(s);
      setError("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [threadId]);
  async function file(path: string) {
    setSelected(path);
    setPatch("");
    setBusy(true);
    try {
      const d = await rpc("threads.diff", {
        thread_id: threadId,
        path,
        include_patch: true,
      });
      setPatch(d.patch);
      setTruncated(!!d.patch_truncated);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    try {
      const r = await rpc("git.commit", {
        thread_id: threadId,
        message: message.trim() || undefined,
      });
      setNotice(
        (r.commits?.length ?? 0) > 1
          ? `Committed ${r.commits!.length} repositories`
          : `Committed ${r.commit.slice(0, 7)}`,
      );
      setAction("");
      setMessage("");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function createPr() {
    setBusy(true);
    try {
      const r = await rpc("github.pr.create", {
        thread_id: threadId,
        title: prTitle.trim() || undefined,
        body: prBody.trim() || undefined,
        draft: true,
        commit_first: false,
      });
      setNotice(`Created draft pull request #${r.number}`);
      setAction("");
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function createGroupPrs() {
    setBusy(true);
    try {
      const r = await rpc("github.pr.create_group", { thread_id: threadId, draft: true, commit_first: true });
      setNotice(prResultToast(r.pull_requests.length, r.skipped ?? []));
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  // Group threads list files under one caption per repository, unchanged ones included.
  const members: MemberLike[] = thread?.members?.length
    ? includedMembers(thread.members)
    : (diff?.repos ?? []).map((repo) => ({ path: repo.repo, name: repo.repo }));
  const grouped = members.length && diff ? groupFilesByRepo(diff, members) : null;
  return (
    <View style={{ gap: 16 }}>
      <ErrorBanner error={error} onRetry={() => void reload()} />
      {notice && (
        <T variant="label" tone="positive">
          {notice}
        </T>
      )}
      {status && (
        <View style={styles.spread}>
          <View style={[styles.line, { flexShrink: 1 }]}>
            <Icon name="arrow.triangle.branch" size={17} />
            {/* Middle truncation keeps the branch's start and "in N repositories" readable. */}
            <T variant="label" numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1 }}>
              {status.branch || (grouped ? "No branch" : "No Git repository")}
              {grouped && (
                <T variant="label" tone="secondary" style={{ fontWeight: "400" }}>
                  {` in ${members.length} ${members.length === 1 ? "repository" : "repositories"}`}
                </T>
              )}
            </T>
          </View>
          <Tap label="Refresh changes" onPress={() => void reload()}>
            <Icon name="arrow.clockwise" size={17} />
          </Tap>
        </View>
      )}
      {busy && <Working label="Loading changes" />}
      {selected ? (
        <>
          <Row
            title="Back to changed files"
            icon="arrow.left"
            onPress={() => setSelected("")}
          />
          <T variant="label" selectable>
            {selected}
          </T>
          <Code
            text={
              patch ||
              (busy
                ? "Loading diff…"
                : "No text changes. This may be a binary file.")
            }
            diff
          />
          {truncated && (
            <T variant="caption" tone="secondary">
              This patch is truncated. Review the complete diff on your
              computer.
            </T>
          )}
        </>
      ) : (
        grouped ? (
          <GroupedChanges
            groups={grouped}
            status={status}
            busy={busy}
            onOpen={(path) => void file(path)}
            onCommit={() =>
              Alert.alert("Commit changes in every repository?", "Each repository with changes gets its own commit with a generated message.", [
                { text: "Cancel", style: "cancel" },
                { text: "Commit changes", onPress: () => void commit() },
              ])
            }
            onCreatePrs={(count) =>
              Alert.alert(
                `${prButtonLabel(count)}?`,
                "Kybern commits current changes, pushes each repository's branch and opens a draft pull request in each, linked to the others.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: prButtonLabel(count), onPress: () => void createGroupPrs() },
                ],
              )
            }
          />
        ) : (
        <>
          {diff?.files.length ? (
            <>
              <View style={styles.line}>
                <T variant="caption" tone="secondary">
                  {diff.files.length} changed{" "}
                  {diff.files.length === 1 ? "file" : "files"}
                </T>
                <T variant="caption" tone="positive">
                  +{diff.files.reduce((n, f) => n + f.additions, 0)}
                </T>
                <T variant="caption" tone="negative">
                  −{diff.files.reduce((n, f) => n + f.deletions, 0)}
                </T>
              </View>
              {diff.files.map((f) => (
                <Row
                  key={f.path}
                  title={f.path}
                  detail={f.status}
                  icon="doc.text"
                  onPress={() => void file(f.path)}
                  trailing={
                    <View style={{ flexDirection: "row", gap: 5 }}>
                      <T variant="caption" tone="positive">
                        +{f.additions}
                      </T>
                      <T variant="caption" tone="negative">
                        −{f.deletions}
                      </T>
                    </View>
                  }
                />
              ))}
            </>
          ) : (
            !busy && (
              <Empty
                icon="checkmark.seal"
                title="Nothing to review."
                detail="Changes made in this workspace will appear here."
              />
            )
          )}
          {status?.pull_request && (
            <Row
              title={`#${status.pull_request.number} ${status.pull_request.title}`}
              detail={status.pull_request.state}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(status.pull_request!.url)}
            />
          )}
          {status?.is_git && (
            <Group title="Git actions">
              <Row
                title="Commit changes"
                detail={
                  status.dirty_files
                    ? `${status.dirty_files} uncommitted files`
                    : "Working tree is clean"
                }
                icon="checkmark.circle"
                onPress={() => setAction(action === "commit" ? "" : "commit")}
              />
              <Row
                title="Create a draft pull request"
                detail="Push this branch and open a draft on GitHub."
                icon="arrow.triangle.pull"
                onPress={() => setAction(action === "pr" ? "" : "pr")}
              />
            </Group>
          )}
          {action === "commit" && (
            <View style={{ gap: 14 }}>
              <Field
                label="Commit message"
                value={message}
                onChangeText={setMessage}
                placeholder="Describe these changes"
                multiline
              />
              <Button
                busy={busy}
                onPress={() =>
                  Alert.alert(
                    "Commit workspace changes?",
                    "All current changes in this workspace will be included.",
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Commit changes", onPress: () => void commit() },
                    ],
                  )
                }
              >
                Commit changes
              </Button>
            </View>
          )}
          {action === "pr" && (
            <View style={{ gap: 14 }}>
              <Field
                label="Pull request title"
                value={prTitle}
                onChangeText={setPrTitle}
                placeholder="Describe this change"
              />
              <Field
                label="Description"
                value={prBody}
                onChangeText={setPrBody}
                placeholder="What changed and how you tested it"
                multiline
              />
              <T variant="caption" tone="secondary">
                Commit your changes first. Creating a pull request pushes this
                branch to GitHub.
              </T>
              <Button
                busy={busy}
                onPress={() =>
                  Alert.alert(
                    "Create a draft pull request?",
                    "This will push your committed branch to GitHub and create a draft pull request.",
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Create draft", onPress: () => void createPr() },
                    ],
                  )
                }
              >
                Create draft pull request
              </Button>
            </View>
          )}
        </>
        )
      )}
    </View>
  );
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <View style={{ flexDirection: "row", gap: 5 }}>
      {additions > 0 && (
        <T variant="caption" tone="positive" style={{ fontVariant: ["tabular-nums"] }}>
          +{additions}
        </T>
      )}
      {deletions > 0 && (
        <T variant="caption" tone="negative" style={{ fontVariant: ["tabular-nums"] }}>
          −{deletions}
        </T>
      )}
    </View>
  );
}

function GroupedChanges({
  groups,
  status,
  busy,
  onOpen,
  onCommit,
  onCreatePrs,
}: {
  groups: RepoFileGroup[];
  status?: GitStatus;
  busy: boolean;
  onOpen: (path: string) => void;
  onCommit: () => void;
  onCreatePrs: (count: number) => void;
}) {
  const { colors } = useTheme();
  const files = groups.reduce((n, group) => n + group.files.length, 0);
  const changed = groups.filter((group) => group.files.length);
  const repos = groups.filter((group) => group.repo.path !== "");
  const pulls = repoPullRows(status?.repos ?? []);
  const plan = prPlan(status?.repos ?? [], new Set(changed.map((group) => group.repo.path)));
  const dirty = (status?.repos ?? []).filter((repo) => repo.included && repo.dirty_files > 0);
  return (
    <>
      <View style={[styles.line, { gap: 6, marginTop: -6 }]}>
        <T variant="caption" tone="secondary">
          {files} changed {files === 1 ? "file" : "files"} · {changedReposLabel(changed.filter((group) => group.repo.path !== "").length, repos.length)}
        </T>
        <Counts additions={groups.reduce((n, g) => n + g.additions, 0)} deletions={groups.reduce((n, g) => n + g.deletions, 0)} />
      </View>
      {groups.map((group) => (
        <View key={group.repo.path || "other"}>
          <View style={[styles.line, { gap: 6, marginTop: 6, marginBottom: group.files.length ? 2 : 10 }]}>
            <Icon name="shippingbox" size={14} color={group.files.length ? colors.ink : colors.secondary} />
            <T variant="caption" tone={group.files.length ? "ink" : "secondary"} style={{ flex: 1, fontWeight: group.files.length ? "600" : "400" }}>
              {group.repo.name}
            </T>
            {group.files.length ? (
              <Counts additions={group.additions} deletions={group.deletions} />
            ) : (
              <T variant="caption" tone="secondary">
                {busy ? "" : "No changes"}
              </T>
            )}
          </View>
          {group.files.map((f) => (
            <Row
              key={f.path}
              title={stripRepoPrefix(f.path, group.repo.path)}
              label={`${group.repo.name}, ${stripRepoPrefix(f.path, group.repo.path)}, ${f.status}`}
              detail={f.status.charAt(0).toUpperCase() + f.status.slice(1)}
              icon="doc.text"
              onPress={() => onOpen(f.path)}
              trailing={<Counts additions={f.additions} deletions={f.deletions} />}
            />
          ))}
        </View>
      ))}
      {!files && !busy && (
        <T tone="secondary">Nothing to review yet. Changes made in these repositories will appear here.</T>
      )}
      {!!pulls.length && (
        <Group title="Pull requests">
          {pulls.map((pull) => (
            <Row
              key={pull.repo}
              title={`${pull.name} · #${pull.pullRequest.number} ${pull.pullRequest.title}`}
              detail={pull.detail}
              icon="arrow.triangle.pull"
              onPress={() => void Linking.openURL(pull.pullRequest.url)}
            />
          ))}
        </Group>
      )}
      <Group title="Git actions">
        <Row
          title="Commit changes"
          detail={dirty.length ? `Uncommitted: ${commitDetail(dirty.reduce((n, repo) => n + repo.dirty_files, 0), dirty.length)}` : "Every repository is clean"}
          icon="checkmark.circle"
          onPress={dirty.length ? onCommit : undefined}
        />
        {!!plan.create.length && (
          <Row
            title={prButtonLabel(plan.create.length)}
            detail={prCaption(plan.create, plan.unchanged, plan.noRemote)}
            icon="arrow.triangle.pull"
            onPress={() => onCreatePrs(plan.create.length)}
          />
        )}
      </Group>
    </>
  );
}
