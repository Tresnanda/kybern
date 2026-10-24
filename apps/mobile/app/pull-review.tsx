// Review a pull request (parity P1-2): comment, approve or request changes. The text is the
// shared review draft, so it survives closing the sheet and is never sent against a newer
// commit than the one it was written for.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import {
  clearReviewDraft,
  reuseReviewDraftText,
  reviewDraftIsStale,
} from "../../../packages/kybern-client/src/prReview";
import type { PrActionKind } from "../src/state/protocol";
import { usePullRequest } from "../src/state/pulls";
import { errorText } from "../src/state/runtime";
import { Button, ErrorBanner, Field, T } from "../src/ui/primitives";
import { Segmented } from "../src/ui/Segmented";
import { showToast } from "../src/ui/Toast";
import { space, useTheme } from "../src/ui/theme";
import { haptics } from "../src/ui/haptics";

type Kind = Extract<PrActionKind, "comment" | "approve" | "request_changes">;
const KINDS: readonly { value: Kind; label: string }[] = [
  { value: "comment", label: "Comment" },
  { value: "approve", label: "Approve" },
  { value: "request_changes", label: "Request changes" },
];
const VERB: Record<Kind, string> = { comment: "Post comment", approve: "Approve", request_changes: "Request changes" };
const DONE: Record<Kind, string> = { comment: "Comment posted", approve: "Pull request approved", request_changes: "Changes requested" };

export default function PullReviewSheet() {
  const { projectId = "", number: raw = "0" } = useLocalSearchParams<{ projectId: string; number: string }>();
  const number = Number(raw);
  const { colors } = useTheme();
  const pr = usePullRequest(projectId, number);
  const [kind, setKind] = useState<Kind>("comment");
  const [error, setError] = useState("");
  const head = pr.detail?.head_sha;
  const stale = head ? reviewDraftIsStale(pr.draft, head) : false;
  const body = pr.draft.body;
  const needsText = kind !== "approve";
  async function submit() {
    setError("");
    try {
      await pr.act(kind);
      haptics.success();
      showToast(DONE[kind]);
      router.back();
    } catch (e) {
      setError(`${errorText(e)} Your review is kept.`);
    }
  }
  return (
    <>
      <Stack.Screen options={{ title: `Review #${number}`, headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: colors.grouped }}
        contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space["3xl"] }}
      >
        {pr.detail && (
          <T variant="subhead" tone="secondary" numberOfLines={2}>
            {pr.detail.pull_request.title}
          </T>
        )}
        <Segmented label="Review type" options={KINDS} value={kind} onChange={setKind} />
        <Field
          label={kind === "approve" ? "Comment (optional)" : kind === "comment" ? "Comment" : "What needs to change"}
          value={body}
          onChangeText={(text) => pr.update({ body: text })}
          placeholder={kind === "request_changes" ? "Describe the changes you need" : "Leave a comment"}
          multiline
          style={{ minHeight: 160, textAlignVertical: "top" }}
        />
        {stale && (
          <View style={{ gap: space.sm, padding: space.md, borderRadius: 14, backgroundColor: colors.warningSoft }}>
            <T variant="subhead" tone="warning">
              This review was written for an earlier commit. Read the current changes, then use the text again or clear it.
            </T>
            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Button
                role="tinted"
                size="medium"
                onPress={() => {
                  try {
                    pr.update(reuseReviewDraftText(pr.draft, head!));
                  } catch (e) {
                    setError(errorText(e));
                  }
                }}
              >
                Use for current commit
              </Button>
              <Button role="plain" size="medium" onPress={() => pr.update(clearReviewDraft(pr.draft))}>
                Clear
              </Button>
            </View>
          </View>
        )}
        <ErrorBanner error={error || pr.error} />
        <Button
          role="prominent"
          busy={pr.busy === kind}
          disabled={!pr.detail || stale || (needsText && !body.trim()) || !!pr.busy}
          onPress={() => void submit()}
        >
          {VERB[kind]}
        </Button>
      </ScrollView>
    </>
  );
}
