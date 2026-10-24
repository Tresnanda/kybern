// Check a pull request out, or send its selected comments to an agent (parity P1-2). Both need
// a conversation with its own worktree in the project: one that already exists, or a new one
// started with the computer's default agent.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { selectedReviewFindings } from "../../../packages/kybern-client/src/prReview";
import { repairBlocked, repairChoices } from "../../../packages/kybern-client/src/pullRequests";
import { count } from "../src/state/format";
import { usePullRequest } from "../src/state/pulls";
import { errorText, useApp } from "../src/state/runtime";
import { threadStatus } from "../src/state/status";
import { InsetGroup, ListRow, SectionFooter, SectionHeader } from "../src/ui/List";
import { Button, Empty, ErrorBanner, T } from "../src/ui/primitives";
import { showToast } from "../src/ui/Toast";
import { haptics } from "../src/ui/haptics";
import { space, useTheme } from "../src/ui/theme";

export default function PullSendSheet() {
  const { projectId = "", number: raw = "0", mode = "repair" } = useLocalSearchParams<{
    projectId: string;
    number: string;
    mode?: "repair" | "checkout";
  }>();
  const number = Number(raw);
  const app = useApp();
  const { colors } = useTheme();
  const pr = usePullRequest(projectId, number);
  const choices = repairChoices(app.threads, projectId);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chosen = choice ?? pr.linked?.id ?? "new";
  const target = chosen === "new" ? undefined : choices.find((t) => t.id === chosen);
  const findings = selectedReviewFindings(pr.draft);
  const repair = mode !== "checkout";
  const blocked = repairBlocked(target);
  const disabled = !pr.detail || blocked || !!pr.busy || (repair && findings.length === 0);

  async function go() {
    setError("");
    try {
      const thread = repair ? await pr.repair(chosen) : await pr.checkout(chosen);
      haptics.success();
      showToast(repair ? "Sent to the agent" : `Checked out #${number}`);
      router.back();
      router.push({ pathname: "/thread/[id]", params: { id: thread } });
    } catch (e) {
      setError(`${errorText(e)}${repair ? " Your selection is kept." : ""}`);
    }
  }
  return (
    <>
      <Stack.Screen
        options={{
          title: repair ? "Send to agent" : `Check out #${number}`,
          headerStyle: { backgroundColor: colors.grouped },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space["3xl"] }}
      >
        <T variant="subhead" tone="secondary">
          {repair
            ? "The agent repairs this branch with your selected comments. You review and merge on GitHub."
            : "The pull request's branch is checked out in the conversation's worktree."}
        </T>

        <SectionHeader title="Conversation" />
        <InsetGroup>
          <ListRow
            title="New conversation"
            subtitle="Default agent, own worktree"
            leading="plus"
            checked={chosen === "new"}
            onPress={() => setChoice("new")}
          />
          {choices.map((thread) => {
            const busy = repairBlocked(thread);
            return (
              <ListRow
                key={thread.id}
                title={thread.title || "Untitled"}
                subtitle={busy ? `${threadStatus(thread.status).word} · finish it first` : thread.worktree?.branch}
                subtitleLines={1}
                leading="text.bubble"
                checked={chosen === thread.id}
                disabled={busy}
                onPress={() => setChoice(thread.id)}
              />
            );
          })}
        </InsetGroup>
        {!choices.length && <SectionFooter>No conversation in this project has its own worktree yet.</SectionFooter>}

        {repair && (
          <>
            <SectionHeader title="Comments" count={findings.length || undefined} />
            {findings.length ? (
              <InsetGroup>
                {findings.slice(0, 5).map((entry) => (
                  <ListRow
                    key={`${entry.id}`}
                    title={entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ""}` : entry.author}
                    mono={!!entry.path}
                    subtitle={entry.body}
                    subtitleLines={2}
                  />
                ))}
                {findings.length > 5 && <ListRow title={`${findings.length - 5} more`} />}
              </InsetGroup>
            ) : (
              <Empty variant="inline" title="Select comments on the pull request first." />
            )}
          </>
        )}

        <ErrorBanner error={error || pr.error} />
        <View style={{ marginTop: space.xl }}>
          <Button
            role="prominent"
            busy={pr.busy === "repair" || pr.busy === "checkout"}
            disabled={disabled}
            onPress={() => void go()}
          >
            {repair ? `Send ${count(findings.length, "comment")}` : "Check out"}
          </Button>
        </View>
      </ScrollView>
    </>
  );
}
