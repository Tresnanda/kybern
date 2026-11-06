// Pull requests across the computer's GitHub projects, or one project's (parity P1-2).
// Native large title and search; a state filter; one section per project.
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, View } from "react-native";
import {
  PR_FILTERS,
  byUpdated,
  emptyPrTitle,
  matchesPrQuery,
  type PrFilter,
} from "../../../packages/kybern-client/src/pullRequests";
import { PrRow, isSetupProblem } from "../src/features/PullRequests";
import type { ProblemModel } from "../src/state/problems";
import type { Project, PullRequest } from "../src/state/protocol";
import { problemFor, rpc, useApp } from "../src/state/runtime";
import { HeaderActions } from "../src/ui/ActionMenu";
import { SectionHeader } from "../src/ui/List";
import { ProblemState } from "../src/ui/Problem";
import { Button, Empty, ErrorBanner } from "../src/ui/primitives";
import { SearchField } from "../src/ui/Search";
import { Segmented } from "../src/ui/Segmented";
import { space, useTheme } from "../src/ui/theme";
import { Working } from "../src/ui/Working";
import { useLists } from "../src/state/useLists";

type Item = { project: Project; pr: PullRequest };
type ListRowItem =
  | { kind: "header"; key: string; title: string; count: number; first: boolean }
  | { kind: "pr"; key: string; item: Item; last: boolean };

const cache = new Map<string, { until: number; rows: PullRequest[]; errors: ProblemModel[] }>();
/** A group project has pull requests in its member repositories, whatever its own folder is. */
const hasPullRequests = (p: Project) => p.is_git || p.kind === "group";
const memberName = (project: Project, repo?: string) =>
  repo ? (project.members?.find((m) => m.path === repo)?.name ?? repo) : undefined;

/** A pull request list failure, worded for the project it came from. */
function prProblem(error: unknown, label: string, projectId: string) {
  return problemFor(error, { action: `load pull requests for ${label}`, goal: "load pull requests" }, { pr: true, params: { project_id: projectId } });
}

export default function PullRequestsScreen() {
  const { projectId: initialProject } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  // Every machine's projects: the computer the phone is at may be away (#245).
  const lists = useLists(null);
  const { colors } = useTheme();
  const [filter, setFilter] = useState<PrFilter>("open");
  const [projectId, setProjectId] = useState<string | null>(initialProject ?? null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState<{ scope: string; items: Item[]; errors: ProblemModel[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const githubProjects = useMemo(() => lists.projects.filter(hasPullRequests), [lists.projects]);
  const targets = useMemo(
    () => githubProjects.filter((p) => !projectId || p.id === projectId),
    [githubProjects, projectId],
  );
  const scope = `${app.activeId}:${filter}:${targets.map((p) => p.id).join(",")}`;
  useEffect(() => {
    if (app.status !== "open") return;
    let canceled = false;
    void Promise.all(
      targets.map(async (project) => {
        const key = `${app.activeId}:${project.id}:${filter}`;
        const hit = cache.get(key);
        try {
          let loaded: { rows: PullRequest[]; errors: ProblemModel[] };
          if (!refreshing && hit && hit.until > Date.now()) loaded = hit;
          else {
            const result = await rpc("github.pr.list", { project_id: project.id, state: filter, limit: 30 });
            // A group project's members that couldn't be listed don't hide the others.
            const errors = (result.repos ?? []).flatMap((m) => {
              if (!m.error || m.skipped) return [];
              const problem = prProblem(m.error, `${project.name} / ${m.name}`, project.id);
              return problem.subject === "github_remote" ? [] : [problem];
            });
            loaded = { rows: result.pull_requests, errors };
          }
          cache.set(key, { until: Date.now() + 30_000, ...loaded });
          return { items: loaded.rows.map((pr) => ({ project, pr })), errors: loaded.errors };
        } catch (e) {
          const problem = prProblem(e, project.name, project.id);
          // A project without a GitHub remote simply has no pull requests.
          return { items: [] as Item[], errors: problem.subject === "github_remote" ? [] : [problem] };
        }
      }),
    ).then((results) => {
      if (canceled) return;
      setLoaded({ scope, items: byUpdated(results.flatMap((r) => r.items)), errors: results.flatMap((r) => r.errors) });
      setRefreshing(false);
    });
    return () => {
      canceled = true;
    };
  }, [scope, revision, app.status]);
  const data = loaded?.scope === scope ? loaded : null;
  const rows = useMemo(() => {
    const matching = (data?.items ?? []).filter(({ pr }) => matchesPrQuery(pr, query));
    const groups = new Map<string, Item[]>();
    for (const item of matching) groups.set(item.project.id, [...(groups.get(item.project.id) ?? []), item]);
    const out: ListRowItem[] = [];
    let first = true;
    for (const [id, items] of groups) {
      if (groups.size > 1 || (!projectId && githubProjects.length > 1)) {
        out.push({ kind: "header", key: `h:${id}`, title: items[0]!.project.name, count: items.length, first });
        first = false;
      }
      items.forEach((item, i) =>
        out.push({ kind: "pr", key: `${id}${item.pr.repo ? `/${item.pr.repo}` : ""}:${item.pr.number}`, item, last: i === items.length - 1 }),
      );
    }
    return out;
  }, [data, query, projectId, githubProjects.length]);
  const failure = data?.errors.find(isSetupProblem);
  const otherErrors = data?.errors.filter((e) => !isSetupProblem(e)) ?? [];
  const project = targets.length === 1 && projectId ? targets[0] : undefined;

  const header = (
    <View style={{ gap: space.md, paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.sm }}>
      <SearchField value={query} onChangeText={setQuery} placeholder="Title, branch or number" />
      <Segmented compact label="Show pull requests" options={PR_FILTERS} value={filter} onChange={setFilter} />
      {otherErrors.slice(0, 3).map((problem, index) => (
        <ErrorBanner key={index} error={problem} onRetry={() => setRevision((n) => n + 1)} />
      ))}
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: project?.name ?? "Pull requests", headerLargeTitleEnabled: true }} />
      {githubProjects.length > 1 && (
        <HeaderActions
          menu={{
            label: "Filter by project",
            title: "Show pull requests from",
            items: [
              { title: "All projects", checked: !projectId, onPress: () => setProjectId(null) },
              ...githubProjects.map((p) => ({
                title: p.name,
                checked: projectId === p.id,
                onPress: () => setProjectId(p.id),
              })),
            ],
          }}
        />
      )}
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: space["3xl"] }}
        data={failure || !data ? [] : rows}
        keyExtractor={(row) => row.key}
        keyboardDismissMode="on-drag"
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              setRevision((n) => n + 1);
            }}
            tintColor={colors.secondary}
          />
        }
        ListEmptyComponent={
          failure ? (
            <ProblemState problem={failure} onRetry={() => setRevision((n) => n + 1)} />
          ) : !data ? (
            app.status === "open" ? <Working label="Loading pull requests" /> : null
          ) : !targets.length ? (
            <Empty
              icon="arrow.triangle.pull"
              title="No GitHub projects"
              detail="Add a project with a GitHub remote on your computer to review its pull requests here."
            />
          ) : query.trim() ? (
            <Empty
              icon="magnifyingglass"
              title={`No pull requests match “${query.trim()}”`}
              action={
                <Button role="plain" size="medium" onPress={() => setQuery("")}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <Empty
              icon="arrow.triangle.pull"
              title={emptyPrTitle(filter)}
              detail={`Pull requests from ${project?.name ?? "your GitHub projects"} appear here.`}
              action={
                filter !== "all" ? (
                  <Button role="plain" size="medium" onPress={() => setFilter("all")}>
                    Show all pull requests
                  </Button>
                ) : undefined
              }
            />
          )
        }
        renderItem={({ item: row }) =>
          row.kind === "header" ? (
            <View style={{ paddingHorizontal: space.lg }}>
              <SectionHeader title={row.title} count={row.count} first={row.first} />
            </View>
          ) : (
            <PrRow
              pr={row.item.pr}
              repoName={memberName(row.item.project, row.item.pr.repo)}
              separator={!row.last}
              onPress={() =>
                router.push({
                  pathname: "/pull",
                  params: {
                    projectId: row.item.project.id,
                    number: String(row.item.pr.number),
                    ...(row.item.pr.repo ? { repo: row.item.pr.repo } : {}),
                  },
                })
              }
            />
          )
        }
      />
    </View>
  );
}
