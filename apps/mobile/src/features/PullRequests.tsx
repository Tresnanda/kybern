// Pull request pieces shared by the list, the detail page and the thread's "…" menu
// (parity P1-2): the state glyph, a list row, and the GitHub CLI problem state.
import * as Clipboard from "expo-clipboard";
import { Linking, View } from "react-native";
import { classifyPrError } from "../../../../packages/kybern-client/src/prReview";
import {
  PR_STATE_WORDS,
  checksDotLabel,
  checksOutcome,
  resolvePrStateKind,
  type CheckBucket,
  type PrStateKind,
} from "../../../../packages/kybern-client/src/pullRequests";
import type { PullRequest } from "../state/protocol";
import type { StatusPhase } from "../state/status";
import { relativeTime } from "../state/threadList";
import { ListRow } from "../ui/List";
import { Button, Empty, Icon } from "../ui/primitives";
import { StatusGlyph } from "../ui/TaskGlyphs";
import { showToast } from "../ui/Toast";
import { useTheme, type Colors } from "../ui/theme";

/** Merged reads as the accent (GitHub's purple has no token); closed and drafts stay quiet. */
export function prStateColor(kind: PrStateKind, colors: Colors) {
  return kind === "open"
    ? colors.positive
    : kind === "merged"
      ? colors.accent
      : kind === "conflicts"
        ? colors.negative
        : colors.secondary;
}

export function PrStateGlyph({ kind, size = 20 }: { kind: PrStateKind; size?: number }) {
  const { colors } = useTheme();
  return <Icon name="arrow.triangle.pull" size={size} color={prStateColor(kind, colors)} />;
}

/** A check bucket drawn with the shared status glyphs. */
export const CHECK_PHASE: Record<CheckBucket, StatusPhase> = {
  passed: "done",
  failed: "failed",
  pending: "working",
  skipped: "stopped",
};

const signedDiff = (pr: PullRequest) =>
  pr.additions != null && pr.deletions != null ? `+${pr.additions} −${pr.deletions}` : undefined;

/** "#42 · octocat · 3h": number, author and last activity. */
export function prMeta(pr: PullRequest) {
  return [`#${pr.number}`, pr.author, relativeTime(pr.updated_at)].filter(Boolean).join(" · ");
}

/** `repoName`: the member repository's display name, for a pull request in a group project. */
export function PrRow({ pr, repoName, onPress, separator }: { pr: PullRequest; repoName?: string; onPress: () => void; separator?: boolean }) {
  const kind = resolvePrStateKind(pr);
  const outcome = checksOutcome(pr.checks_summary);
  return (
    <ListRow
      title={pr.title}
      titleLines={2}
      subtitle={repoName ? `${repoName} · ${prMeta(pr)}` : prMeta(pr)}
      subtitleLines={1}
      leading={
        <View>
          <PrStateGlyph kind={kind} />
          {outcome ? (
            <View style={{ position: "absolute", end: -6, bottom: -4 }}>
              <StatusGlyph phase={CHECK_PHASE[outcome]} size={12} />
            </View>
          ) : null}
        </View>
      }
      meta={signedDiff(pr)}
      label={[
        pr.title,
        repoName ?? "",
        PR_STATE_WORDS[kind],
        prMeta(pr),
        pr.checks_summary?.total ? checksDotLabel(pr.checks_summary) : "",
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onPress}
      menu={[
        { title: "Open on GitHub", icon: "arrow.up.right", onPress: () => void Linking.openURL(pr.url) },
        {
          title: "Copy link",
          icon: "link",
          onPress: () => {
            void Clipboard.setStringAsync(pr.url);
            showToast("Link copied");
          },
        },
      ]}
      menuTitle={`#${pr.number} ${pr.title}`}
      separator={separator}
    />
  );
}

/** The GitHub CLI is missing or signed out on the computer: say how to fix it there. */
export function GhProblem({ error, onRetry }: { error: string; onRetry: () => void }) {
  const kind = classifyPrError(error);
  if (kind !== "gh-missing" && kind !== "gh-auth") return null;
  const missing = kind === "gh-missing";
  return (
    <Empty
      icon="arrow.triangle.pull"
      title={missing ? "Install the GitHub CLI" : "Sign in to the GitHub CLI"}
      detail={
        missing
          ? "Kybern reads pull requests through gh on your computer. Install it there, run gh auth login, then try again."
          : "Run gh auth login in a terminal on your computer, then try again."
      }
      action={
        <Button role="tinted" size="medium" onPress={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

export const isGhProblem = (error: string) => {
  const kind = classifyPrError(error);
  return kind === "gh-missing" || kind === "gh-auth";
};
