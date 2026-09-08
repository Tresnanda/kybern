import { useEffect, useState } from "react";
import { Alert, Linking, View } from "react-native";
import { type Diff, type GitStatus } from "../state/protocol";
import { errorText, rpc } from "../state/runtime";
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
      setNotice(`Committed ${r.commit.slice(0, 7)}`);
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
          <View style={styles.line}>
            <Icon name="arrow.triangle.branch" size={17} />
            <T variant="label">{status.branch || "No Git repository"}</T>
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
      )}
    </View>
  );
}
