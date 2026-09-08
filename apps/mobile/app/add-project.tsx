import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { setDraft } from "../src/state/draft";
import type { ProjectsBrowseResult } from "../src/state/protocol";
import { errorText, refresh, rpc } from "../src/state/runtime";
import { Button, ErrorBanner, Field, Page, Row, T } from "../src/ui/primitives";
export default function AddProject() {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [browse, setBrowse] = useState<ProjectsBrowseResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  async function directories(next?: string) {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await rpc("projects.browse", next ? { path: next } : {});
      if (id === request.current) {
        setBrowse(result);
        setPath(result.path);
      }
    } catch (e) {
      if (id === request.current) setError(errorText(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  useEffect(() => {
    void directories();
    return () => {
      request.current++;
    };
  }, []);
  async function add() {
    setBusy(true);
    setError("");
    try {
      const project = await rpc("projects.add", {
        path: path.trim(),
        name: name.trim() || undefined,
      });
      await refresh();
      setDraft({ projectId: project.id, baseBranch: "" });
      router.dismissTo("/");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <T tone="secondary" style={{ marginBottom: 24 }}>
        Choose an existing folder on your computer. It will also appear in the
        desktop app.
      </T>
      <View style={{ gap: 16 }}>
        <Field
          label="Folder on your computer"
          value={path}
          onChangeText={setPath}
          autoCorrect={false}
          autoCapitalize="none"
          placeholder="/Users/you/projects/my-app"
        />
        <Button secondary busy={busy} onPress={() => void directories(path)}>
          Browse folder
        </Button>
        <Field
          label="Project name (optional)"
          value={name}
          onChangeText={setName}
          placeholder="Use folder name"
        />
        <ErrorBanner error={error} />
        <Button busy={busy} disabled={!path.trim()} onPress={() => void add()}>
          Add this folder
        </Button>
      </View>
      {browse && (
        <View style={{ marginTop: 24 }}>
          <T variant="caption" tone="secondary">
            Folders in {browse.path}
          </T>
          {browse.parent && (
            <Row
              title="Parent folder"
              icon="arrow.up"
              onPress={() => void directories(browse.parent!)}
            />
          )}
          {browse.directories.map((d) => (
            <Row
              key={d.path}
              title={d.name}
              icon="folder"
              onPress={() => void directories(d.path)}
            />
          ))}
          {!browse.directories.length && (
            <T tone="secondary" style={{ marginTop: 12 }}>
              No subfolders. You can add the current folder.
            </T>
          )}
          {browse.has_more && (
            <T variant="caption" tone="secondary">
              Enter a folder path above to find more folders.
            </T>
          )}
        </View>
      )}
    </Page>
  );
}
