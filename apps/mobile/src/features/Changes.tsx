// Changes (ux-thread M8): the thread's changed files and the git actions on them. 44 pt file
// rows: a status letter badge, the file name, its directory in MONO (middle-truncated) and a
// tabular +n −m. Group threads get one section per repository. Tapping a file shows its patch
// in place, so the screen works the same full-screen and in the iPad inspector.
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, View, useWindowDimensions } from "react-native";
import { confirm } from "../ui/Alert";
import type { Diff, FileChange, FileStatus, GitStatus } from "../state/protocol";
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
import { count } from "../state/format";
import { Code } from "../ui/Markdown";
import { InsetGroup, ListRow, SectionHeader } from "../ui/List";
import { Button, Empty, ErrorBanner, Field, Icon, IconButton, T, Tap } from "../ui/primitives";
import { showToast } from "../ui/Toast";
import { MONO, gutter, radius, space, useTheme, type Colors } from "../ui/theme";
import { Working } from "../ui/Working";

const BADGE: Record<FileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  type_changed: "T",
  unknown: "?",
};
const STATUS_WORD: Record<FileStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
  unknown: "Changed",
};
const badgeColor = (status: FileStatus, colors: Colors) =>
  status === "added" ? colors.positive : status === "deleted" ? colors.negative : status === "modified" ? colors.warning : colors.accent;

/** `a/b/c.ts` → name `c.ts`, directory `a/b`. */
function splitPath(path: string) {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

function Counts({ additions, deletions }: { additions: number; deletions: number }) {
  if (!additions && !deletions) return null;
  return (
    <View style={{ flexDirection: "row", gap: space.xs }}>
      {additions > 0 && (
        <T variant="footnote" tone="positive" style={{ fontVariant: ["tabular-nums"] }}>
          +{additions}
        </T>
      )}
      {deletions > 0 && (
        <T variant="footnote" tone="negative" style={{ fontVariant: ["tabular-nums"] }}>
          −{deletions}
        </T>
      )}
    </View>
  );
}

function ChangeRow({ file, shown, onPress, separator }: { file: FileChange; shown: string; onPress: () => void; separator: boolean }) {
  const { colors } = useTheme();
  const { name, dir } = splitPath(shown);
  const tint = badgeColor(file.status, colors);
  return (
    <Tap
      label={`${shown}, ${STATUS_WORD[file.status]}, ${file.additions} added, ${file.deletions} removed`}
      feedback="highlight"
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 44, paddingHorizontal: space.lg, gap: space.md, backgroundColor: colors.surface }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: radius.xs - 1,
          borderWidth: 1,
          borderColor: tint,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <T variant="caption" style={{ color: tint, fontFamily: MONO, fontWeight: "600", lineHeight: 14 }} maxFontSizeMultiplier={1.2}>
          {BADGE[file.status]}
        </T>
      </View>
      <View style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: space.sm, minWidth: 0 }}>
        <T variant="label" style={{ fontWeight: "400", flexShrink: 0, maxWidth: "70%" }} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </T>
        {dir ? (
          <T variant="caption" tone="muted" style={{ fontFamily: MONO, flex: 1 }} numberOfLines={1} ellipsizeMode="middle">
            {dir}
          </T>
        ) : (
          <View style={{ flex: 1 }} />
        )}
      </View>
      {file.binary ? (
        <T variant="footnote" tone="muted">
          Binary
        </T>
      ) : (
        <Counts additions={file.additions} deletions={file.deletions} />
      )}
      {separator && (
        <View
          pointerEvents="none"
          style={{ position: "absolute", bottom: 0, end: 0, start: space.lg + 18 + space.md, height: 0.5, backgroundColor: colors.line }}
        />
      )}
    </Tap>
  );
}

function FileList({ files, prefix = "", onOpen }: { files: FileChange[]; prefix?: string; onOpen: (path: string) => void }) {
  if (!files.length) return null;
  return (
    <InsetGroup>
      {files.map((file, i) => (
        <ChangeRow
          key={file.path}
          file={file}
          shown={prefix ? stripRepoPrefix(file.path, prefix) : file.path}
          separator={i < files.length - 1}
          onPress={() => onOpen(file.path)}
        />
      ))}
    </InsetGroup>
  );
}

export function Changes({ threadId }: { threadId: string }) {
  const { colors } = useTheme();
  const edge = gutter(useWindowDimensions().width);
  const thread = useApp().threads.find((t) => t.id === threadId);
  const [diff, setDiff] = useState<Diff>();
  const [status, setStatus] = useState<GitStatus>();
  const [selected, setSelected] = useState("");
  const [patch, setPatch] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [message, setMessage] = useState("");
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      const d = await rpc("threads.diff", { thread_id: threadId, path, include_patch: true });
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
      const r = await rpc("git.commit", { thread_id: threadId, message: message.trim() || undefined });
      showToast((r.commits?.length ?? 0) > 1 ? `Committed ${r.commits!.length} repositories` : `Committed ${r.commit.slice(0, 7)}`);
      setComposing(false);
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
      const r = await rpc("github.pr.create", { thread_id: threadId, draft: true, commit_first: true });
      showToast(`Opened draft pull request #${r.number}`, {
        title: "View",
        onPress: () =>
          thread?.project_id
            ? router.push({ pathname: "/pull", params: { projectId: thread.project_id, number: String(r.number) } })
            : void Linking.openURL(r.url),
      });
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
      showToast(prResultToast(r.pull_requests.length, r.skipped ?? []));
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  // Group threads list files under one header per repository, unchanged ones included.
  const members: MemberLike[] = thread?.members?.length
    ? includedMembers(thread.members)
    : (diff?.repos ?? []).map((repo) => ({ path: repo.repo, name: repo.repo }));
  const grouped = members.length && diff ? groupFilesByRepo(diff, members) : null;
  const files = diff?.files ?? [];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);

  if (selected) {
    const { name, dir } = splitPath(selected);
    return (
      <View style={{ gap: space.md, paddingHorizontal: edge }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginStart: -space.md }}>
          <IconButton name="chevron.left" label="Back to changed files" onPress={() => setSelected("")} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="headline" numberOfLines={1} ellipsizeMode="middle">
              {name}
            </T>
            {!!dir && (
              <T variant="code" tone="muted" numberOfLines={1} ellipsizeMode="middle" selectable>
                {dir}
              </T>
            )}
          </View>
        </View>
        <ErrorBanner error={error} />
        <View style={{ gap: space.sm }}>
          {busy && !patch ? (
            <Working label="Loading diff" />
          ) : (
            <Code text={patch || "No text changes. This may be a binary file."} diff />
          )}
          {truncated && (
            <T variant="footnote" tone="muted">
              This patch is truncated. Review the complete diff on your computer.
            </T>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: edge }}>
      <ErrorBanner error={error} onRetry={() => void reload()} />
      {status && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, marginEnd: -space.md }}>
          <Icon name="arrow.triangle.branch" size={16} color={colors.secondary} />
          {/* Middle truncation keeps the branch's start and end readable. */}
          <T variant="code" numberOfLines={1} ellipsizeMode="middle" style={{ flex: 1 }}>
            {status.branch || (grouped ? `${members.length} repositories` : "No Git repository")}
          </T>
          <IconButton name="arrow.clockwise" label="Refresh changes" disabled={busy} onPress={() => void reload()} />
        </View>
      )}
      {busy && !diff && <Working label="Loading changes" />}
      {grouped ? (
        <GroupedChanges
          groups={grouped}
          status={status}
          busy={busy}
          onOpen={(path) => void file(path)}
          onCommit={() =>
            confirm({
              title: "Commit changes in every repository?",
              message: "Each repository with changes gets its own commit with a generated message.",
              confirm: "Commit",
              destructive: false,
              onConfirm: () => void commit(),
            })
          }
          onCreatePrs={(n) =>
            confirm({
              title: `${prButtonLabel(n)}?`,
              message: "Kybern commits current changes, pushes each repository's branch and opens a linked draft pull request in each.",
              confirm: "Create",
              destructive: false,
              onConfirm: () => void createGroupPrs(),
            })
          }
        />
      ) : (
        <>
          {files.length ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm, paddingBottom: space.sm }}>
                <T variant="footnote" tone="secondary">
                  {count(files.length, "changed file")}
                </T>
                <Counts additions={adds} deletions={dels} />
              </View>
              <FileList files={files} onOpen={(path) => void file(path)} />
            </>
          ) : (
            !busy &&
            diff && (
              <Empty icon="checkmark.seal" title="No changes" detail="Files this thread changes appear here." />
            )
          )}
          {status?.is_git && (
            <View>
              <SectionHeader title="Git" />
              <InsetGroup>
                <ListRow
                  title="Commit changes"
                  subtitle={status.dirty_files ? count(status.dirty_files, "uncommitted file") : "Working tree is clean"}
                  leading="checkmark.circle"
                  disabled={!status.dirty_files}
                  onPress={() => setComposing((v) => !v)}
                />
                {status.pull_request ? (
                  <ListRow
                    title={`Pull request #${status.pull_request.number}`}
                    subtitle={status.pull_request.title}
                    subtitleLines={1}
                    leading="arrow.triangle.pull"
                    chevron
                    onPress={() =>
                      thread?.project_id
                        ? router.push({
                            pathname: "/pull",
                            params: { projectId: thread.project_id, number: String(status.pull_request!.number) },
                          })
                        : void Linking.openURL(status.pull_request!.url)
                    }
                  />
                ) : (
                  <ListRow
                    title="Create a draft pull request"
                    subtitle={status.remote_url ? "Commits, pushes this branch and opens a draft on GitHub" : "Add a GitHub remote on your computer first"}
                    leading="arrow.triangle.pull"
                    disabled={!status.remote_url || busy}
                    onPress={() =>
                      confirm({
                        title: "Create a draft pull request?",
                        message: "Kybern commits current changes, pushes this branch and opens a draft pull request on GitHub.",
                        confirm: "Create",
                        destructive: false,
                        onConfirm: () => void createPr(),
                      })
                    }
                  />
                )}
              </InsetGroup>
              {composing && (
                <View style={{ gap: space.md, paddingTop: space.lg }}>
                  <Field
                    label="Commit message"
                    value={message}
                    onChangeText={setMessage}
                    placeholder="Leave empty for a generated message"
                    multiline
                  />
                  <Button role="prominent" busy={busy} onPress={() => void commit()}>
                    Commit changes
                  </Button>
                </View>
              )}
            </View>
          )}
        </>
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
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
        <T variant="footnote" tone="secondary">
          {`${count(files, "changed file")} · ${changedReposLabel(changed.filter((group) => group.repo.path !== "").length, repos.length)}`}
        </T>
        <Counts additions={groups.reduce((n, g) => n + g.additions, 0)} deletions={groups.reduce((n, g) => n + g.deletions, 0)} />
      </View>
      {groups.map((group) => (
        <View key={group.repo.path || "other"}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <SectionHeader title={group.repo.name} count={group.files.length || undefined} />
            </View>
            <View style={{ paddingBottom: space.sm }}>
              {group.files.length ? (
                <Counts additions={group.additions} deletions={group.deletions} />
              ) : (
                <T variant="footnote" tone="muted">
                  {busy ? "" : "No changes"}
                </T>
              )}
            </View>
          </View>
          <FileList files={group.files} prefix={group.repo.path} onOpen={onOpen} />
        </View>
      ))}
      {!files && !busy && (
        <Empty icon="checkmark.seal" title="No changes" detail="Files changed in these repositories appear here." />
      )}
      <View>
        {!!pulls.length && (
          <>
            <SectionHeader title="Pull requests" count={pulls.length} />
            <InsetGroup>
              {pulls.map((pull) => (
                <ListRow
                  key={pull.repo}
                  title={`${pull.name} #${pull.pullRequest.number}`}
                  subtitle={pull.pullRequest.title}
                  subtitleLines={1}
                  leading="arrow.up.right"
                  onPress={() => void Linking.openURL(pull.pullRequest.url)}
                />
              ))}
            </InsetGroup>
          </>
        )}
        <SectionHeader title="Git" />
        <InsetGroup>
          <ListRow
            title="Commit changes"
            subtitle={dirty.length ? `Uncommitted: ${commitDetail(dirty.reduce((n, repo) => n + repo.dirty_files, 0), dirty.length)}` : "Every repository is clean"}
            leading="checkmark.circle"
            disabled={!dirty.length}
            onPress={onCommit}
          />
          {!!plan.create.length && (
            <ListRow
              title={prButtonLabel(plan.create.length)}
              subtitle={prCaption(plan.create, plan.unchanged, plan.noRemote)}
              leading="arrow.triangle.pull"
              onPress={() => onCreatePrs(plan.create.length)}
            />
          )}
        </InsetGroup>
      </View>
    </>
  );
}
