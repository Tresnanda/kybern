// One pull request (parity P1-2): state, branches, checks, description and conversation.
// Review opens a sheet; Check out and Send to agent pick a worktree conversation in a sheet;
// comments can be selected and sent to an agent that repairs the branch.
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Linking, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { classifyPrError } from "../../../packages/kybern-client/src/prReview";
import {
  PR_STATE_WORDS,
  checkBucket,
  checksOutcome,
  checksPhrase,
  resolvePrStateKind,
  reviewDecisionWord,
  sortChecks,
  summarizeChecks,
} from "../../../packages/kybern-client/src/pullRequests";
import { CHECK_PHASE, GhProblem, PrStateGlyph, isGhProblem, prStateColor } from "../src/features/PullRequests";
import { count } from "../src/state/format";
import type { PrReviewEntry } from "../src/state/protocol";
import { usePrPage, usePullRequest } from "../src/state/pulls";
import { useApp } from "../src/state/runtime";
import { relativeTime } from "../src/state/threadList";
import { HeaderActions, type MenuItem } from "../src/ui/ActionMenu";
import { confirm } from "../src/ui/Alert";
import { Check } from "../src/ui/CheckRow";
import { ChromeBar } from "../src/ui/ChromeBar";
import { InsetGroup, ListRow, SectionHeader } from "../src/ui/List";
import { Markdown } from "../src/ui/Markdown";
import { Button, Empty, ErrorBanner, T, Tap } from "../src/ui/primitives";
import { StatusGlyph } from "../src/ui/TaskGlyphs";
import { showToast } from "../src/ui/Toast";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";
import { useWindowDimensions } from "react-native";

const CHECKS_SHOWN = 5;
const BUCKET_WORD = { passed: "Passed", failed: "Failing", pending: "Running", skipped: "Skipped" } as const;

export default function PullRequestScreen() {
  const { projectId = "", number: raw = "0" } = useLocalSearchParams<{ projectId: string; number: string }>();
  const number = Number(raw);
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const project = app.projects.find((p) => p.id === projectId);
  const pr = usePullRequest(projectId, number);
  const detail = pr.detail;
  const head = detail?.head_sha;
  const comments = usePrPage(projectId, number, "comments", pr.revision, head);
  const reviews = usePrPage(projectId, number, "reviews", pr.revision, head);
  const inline = usePrPage(projectId, number, "review_comments", pr.revision, head);
  const [allChecks, setAllChecks] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const entries = useMemo(() => {
    const tagged = [
      ...(comments.data?.entries ?? []).map((entry) => ({ id: `comments:${entry.id}`, entry })),
      ...(reviews.data?.entries ?? []).filter((e) => e.body.trim()).map((entry) => ({ id: `reviews:${entry.id}`, entry })),
      ...(inline.data?.entries ?? []).map((entry) => ({ id: `review_comments:${entry.id}`, entry })),
    ];
    return tagged.sort((a, b) => a.entry.updated_at.localeCompare(b.entry.updated_at));
  }, [comments.data, reviews.data, inline.data]);
  const pageError = comments.error ?? reviews.error ?? inline.error;

  const p = detail?.pull_request;
  const kind = p ? resolvePrStateKind(p, detail?.merge_state_status) : "open";
  const open = p?.state.toUpperCase() === "OPEN";
  const checks = useMemo(() => sortChecks(detail?.checks ?? []), [detail?.checks]);
  const summary = summarizeChecks(checks);
  const outcome = checksOutcome(summary);
  const selected = pr.draft.selected.length;

  function copyLink() {
    if (!p) return;
    void Clipboard.setStringAsync(p.url);
    showToast("Link copied");
  }
  function close() {
    confirm({
      title: `Close pull request #${number}?`,
      message: "It stays on GitHub and can be reopened there.",
      confirm: "Close",
      onConfirm: () =>
        void pr.act("close").then(
          () => showToast("Pull request closed"),
          (e) => showToast(String((e as Error).message ?? e)),
        ),
    });
  }
  const openSheet = (mode: "review" | "checkout" | "repair") =>
    router.push({
      pathname: mode === "review" ? "/pull-review" : "/pull-send",
      params: { projectId, number: String(number), ...(mode === "review" ? {} : { mode }) },
    });
  const menu: MenuItem[] = [
    { title: "Send to agent…", icon: "paperplane", disabled: !open, onPress: () => openSheet("repair") },
    { title: "Check out…", icon: "arrow.triangle.branch", disabled: !open, onPress: () => openSheet("checkout") },
    { title: "Open on GitHub", icon: "arrow.up.right", disabled: !p, onPress: () => p && void Linking.openURL(p.url) },
    { title: "Copy link", icon: "link", disabled: !p, onPress: copyLink },
    ...(open ? [{ title: "Close pull request…", icon: "xmark.circle" as const, destructive: true, onPress: close }] : []),
  ];

  return (
    <View style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ title: `#${number}`, headerStyle: { backgroundColor: colors.grouped } }} />
      <HeaderActions
        buttons={open ? [{ title: "Review", onPress: () => openSheet("review"), disabled: !detail }] : []}
        menu={{ label: "Pull request actions", title: p ? `#${number} ${p.title}` : undefined, items: menu }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingHorizontal: gutter(width),
          paddingTop: space.sm,
          paddingBottom: insets.bottom + (selected ? 96 : space["3xl"]),
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          alignSelf: "center",
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing && pr.loading}
            onRefresh={() => {
              setRefreshing(true);
              pr.reload();
            }}
            tintColor={colors.secondary}
          />
        }
      >
        {pr.error && isGhProblem(pr.error) ? (
          <GhProblem error={pr.error} onRetry={pr.reload} />
        ) : !detail ? (
          pr.error ? (
            <ErrorBanner
              error={classifyPrError(pr.error) === "no-remote" ? "This project has no GitHub remote." : pr.error}
              onRetry={pr.reload}
            />
          ) : (
            <Working label="Loading pull request" />
          )
        ) : (
          <>
            <ErrorBanner error={pr.error} onRetry={pr.reload} />
            <View style={{ gap: space.sm, paddingBottom: space.sm }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
                <PrStateGlyph kind={kind} size={17} />
                <T variant="subhead" style={{ color: prStateColor(kind, colors), fontWeight: "600" }}>
                  {PR_STATE_WORDS[kind]}
                </T>
                {!!reviewDecisionWord(p!.review_decision) && open && (
                  <T variant="subhead" tone="secondary">
                    {`· ${reviewDecisionWord(p!.review_decision)}`}
                  </T>
                )}
              </View>
              <T variant="title" selectable>
                {p!.title}
              </T>
              <T variant="footnote" tone="secondary">
                {`${p!.author} wants to merge `}
                <T variant="code" tone="ink">
                  {p!.head}
                </T>
                {" into "}
                <T variant="code" tone="ink">
                  {p!.base}
                </T>
              </T>
              <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
                {[
                  project?.name,
                  `Updated ${relativeTime(p!.updated_at) === "Now" ? "just now" : `${relativeTime(p!.updated_at)} ago`}`,
                  count(detail.changed_files, "file"),
                  p!.additions != null ? `+${p!.additions} −${p!.deletions ?? 0}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </T>
            </View>

            <SectionHeader title="Checks" count={checks.length || undefined} />
            <InsetGroup>
              <ListRow
                title={checksPhrase(summary)}
                leading={outcome ? <StatusGlyph phase={CHECK_PHASE[outcome]} size={18} animated={outcome === "pending"} /> : "checkmark.seal"}
              />
              {(allChecks ? checks : checks.slice(0, CHECKS_SHOWN)).map((check, i) => {
                const bucket = checkBucket(check);
                return (
                  <ListRow
                    key={`${check.name}:${i}`}
                    title={check.name}
                    subtitle={BUCKET_WORD[bucket]}
                    subtitleLines={1}
                    leading={<StatusGlyph phase={CHECK_PHASE[bucket]} size={16} animated={bucket === "pending"} />}
                    chevron={!!check.url}
                    onPress={check.url ? () => void Linking.openURL(check.url) : undefined}
                  />
                );
              })}
              {checks.length > CHECKS_SHOWN && (
                <ListRow
                  title={allChecks ? "Show fewer" : `Show all ${checks.length}`}
                  onPress={() => setAllChecks((v) => !v)}
                />
              )}
            </InsetGroup>

            <SectionHeader title="Description" />
            <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.lg }}>
              {detail.body.trim() ? (
                <Markdown text={detail.body} />
              ) : (
                <T variant="subhead" tone="muted">
                  No description provided.
                </T>
              )}
            </View>

            <SectionHeader
              title="Conversation"
              count={entries.length || undefined}
              action={selected ? { title: "Clear", label: "Clear selected comments", onPress: () => pr.update({ selected: [], findings: {} }) } : undefined}
            />
            {pageError ? (
              <ErrorBanner error={pageError} onRetry={pr.reload} />
            ) : !comments.data && !reviews.data ? (
              <Working label="Loading conversation" />
            ) : entries.length ? (
              <View style={{ gap: space.sm }}>
                {entries.map(({ id, entry }) => (
                  <Comment
                    key={id}
                    entry={entry}
                    selected={pr.draft.selected.includes(id)}
                    selectable={open}
                    onToggle={() => {
                      try {
                        pr.toggleFinding(id, entry);
                      } catch (e) {
                        showToast((e as Error).message);
                      }
                    }}
                  />
                ))}
                {open && (
                  <T variant="footnote" tone="muted" style={{ paddingHorizontal: space.lg }}>
                    Select comments to send them to an agent that repairs this branch.
                  </T>
                )}
              </View>
            ) : (
              <Empty variant="inline" title="No comments yet." />
            )}
          </>
        )}
      </ScrollView>
      {selected > 0 && open && (
        <ChromeBar edge="bottom" tone="grouped">
          <View style={{ paddingHorizontal: gutter(width), paddingTop: space.md, paddingBottom: insets.bottom ? 0 : space.lg }}>
            <Button role="prominent" onPress={() => openSheet("repair")}>
              {`Send ${count(selected, "comment")} to agent`}
            </Button>
          </View>
        </ChromeBar>
      )}
    </View>
  );
}

function Comment({
  entry,
  selected,
  selectable,
  onToggle,
}: {
  entry: PrReviewEntry;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const where = entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ""}` : "";
  const review = reviewDecisionWord(entry.state);
  return (
    <View style={{ backgroundColor: colors.surface, borderRadius: radius.md, padding: space.lg, gap: space.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
            <T variant="subhead" style={{ fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
              {entry.author}
            </T>
            <T variant="footnote" tone="muted" style={{ fontVariant: ["tabular-nums"] }}>
              {relativeTime(entry.updated_at)}
            </T>
            {entry.state === "APPROVED" || entry.state === "CHANGES_REQUESTED" ? (
              <T variant="footnote" tone={entry.state === "APPROVED" ? "positive" : "warning"}>
                {review}
              </T>
            ) : null}
          </View>
          {where ? (
            <T variant="code" tone="secondary" numberOfLines={1} ellipsizeMode="middle">
              {where}
            </T>
          ) : null}
        </View>
        {selectable && (
          <Tap
            label={selected ? "Deselect comment" : "Select comment for the agent"}
            selected={selected}
            feedback="none"
            onPress={onToggle}
            hitSlop={8}
            style={{ width: 44, alignItems: "flex-end" }}
          >
            <Check checked={selected} size={22} />
          </Tap>
        )}
      </View>
      <Markdown text={entry.body} />
    </View>
  );
}
