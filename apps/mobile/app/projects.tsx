import { router } from "expo-router";
import { useState } from "react";
import { Alert, Linking, View } from "react-native";
import { setDraft } from "../src/state/draft";
import { type Project, type PullRequest } from "../src/state/protocol";
import { errorText, refresh, rpc, useApp } from "../src/state/runtime";
import {
  Button,
  Empty,
  ErrorBanner,
  Group,
  Page,
  Row,
  T,
} from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function Projects() {
  const app = useApp();
  const { colors } = useTheme();
  const [selected, setSelected] = useState<Project>();
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [prsLoaded, setPrsLoaded] = useState(false);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [error, setError] = useState("");
  function choose(project: Project) {
    setSelected(project);
    setPrs([]);
    setError("");
    setPrsLoaded(false);
  }
  async function loadPullRequests() {
    if (!selected) return;
    setLoadingPrs(true);
    setError("");
    try {
      const r = await rpc("github.pr.list", {
        project_id: selected.id,
        state: "open",
        limit: 30,
      });
      setPrs(r.pull_requests);
      setPrsLoaded(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingPrs(false);
    }
  }
  return (
    <Page>
      <ErrorBanner error={error} />
      {selected ? (
        <>
          <Row
            title="All projects"
            icon="arrow.left"
            onPress={() => {
              setSelected(undefined);
              setError("");
            }}
          />
          <T variant="title">{selected.name}</T>
          <T
            variant="caption"
            tone="secondary"
            selectable
            style={{ marginVertical: 10 }}
          >
            {selected.path}
          </T>
          <Group>
            <Row
              title="Start a thread"
              icon="square.and.pencil"
              onPress={() => {
                setDraft({ projectId: selected.id });
                router.dismissTo("/");
              }}
            />
            <Row
              title="Browse files"
              icon="folder"
              onPress={() =>
                router.push({
                  pathname: "/workspace",
                  params: { projectId: selected.id, tab: "Files" },
                })
              }
            />
            <Row
              title="Rename project"
              icon="pencil"
              onPress={() =>
                Alert.prompt(
                  "Rename project",
                  undefined,
                  (value) => {
                    if (value?.trim())
                      void rpc("projects.update", {
                        project_id: selected.id,
                        name: value.trim(),
                      })
                        .then((p) => {
                          setSelected(p);
                          return refresh();
                        })
                        .catch((e) => setError(errorText(e)));
                  },
                  "plain-text",
                  selected.name,
                )
              }
            />
            <Row
              title="Remove project"
              icon="minus.circle"
              danger
              onPress={() =>
                Alert.alert(
                  "Remove this project?",
                  "The project disappears from Kybern. Files on your computer are kept.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove project",
                      style: "destructive",
                      onPress: () => {
                        void rpc("projects.remove", { project_id: selected.id })
                          .then(async () => {
                            await refresh();
                            setSelected(undefined);
                          })
                          .catch((e) => setError(errorText(e)));
                      },
                    },
                  ],
                )
              }
            />
          </Group>
          <Group title="Open pull requests">
            {!prsLoaded ? (
              <Button
                secondary
                busy={loadingPrs}
                onPress={() => void loadPullRequests()}
              >
                Load pull requests
              </Button>
            ) : prs.length ? (
              prs.map((pr) => (
                <Row
                  key={pr.number}
                  title={pr.title}
                  detail={`#${pr.number} · ${pr.head} → ${pr.base}${pr.is_draft ? " · Draft" : ""}`}
                  icon="arrow.triangle.pull"
                  onPress={() => void Linking.openURL(pr.url)}
                />
              ))
            ) : (
              <T tone="secondary">No open pull requests.</T>
            )}
          </Group>
        </>
      ) : (
        <>
          <T tone="secondary" style={{ marginBottom: 24 }}>
            Projects on your connected computer.
          </T>
          {app.projects.map((p) => (
            <Row
              key={p.id}
              title={p.name}
              detail={p.path}
              icon="folder"
              onPress={() => void choose(p)}
            />
          ))}
          {!app.projects.length && (
            <Empty
              icon="folder"
              title="Bring a project along."
              detail="Choose a folder on your connected computer to start working with an agent."
            />
          )}
          <View style={{ marginTop: 24 }}>
            <Button
              secondary
              icon="plus"
              disabled={app.status !== "open"}
              onPress={() => router.push("/add-project")}
            >
              Add project
            </Button>
          </View>
        </>
      )}
    </Page>
  );
}
