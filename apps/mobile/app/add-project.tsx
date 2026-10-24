import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  GROUP_COPY,
  memberSelectionError,
  memberSelectionHelper,
  orderMemberPaths,
  selectedCountLabel,
} from "../../../packages/kybern-client/src/groups";
import { setDraft } from "../src/state/draft";
import { candidateDetail, toggleCandidate } from "../src/state/groups";
import type { ProjectsBrowseResult, ProjectsScanReposResult } from "../src/state/protocol";
import { errorText, refresh, rpc, supportsGroupProjects, useApp } from "../src/state/runtime";
import { CheckRow } from "../src/ui/CheckRow";
import { Button, ErrorBanner, Field, Icon, Page, Row, T, Tap, styles } from "../src/ui/primitives";
import { Segmented } from "../src/ui/Segmented";
import { useTheme } from "../src/ui/theme";

type Kind = "single" | "group";

// The form below the Segmented changes height, so it cross-fades in place rather than sliding.
const swap = FadeIn.duration(150).reduceMotion(ReduceMotion.Never);

/** One `projects.browse` listing at a time; a newer request wins over a slower one. */
function useBrowse() {
  const [browse, setBrowse] = useState<ProjectsBrowseResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function open(path?: string) {
    const id = ++request.current;
    setBusy(true);
    setError("");
    try {
      const result = await rpc("projects.browse", path ? { path } : {});
      if (id === request.current) setBrowse(result);
      return result;
    } catch (e) {
      if (id === request.current) setError(errorText(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }
  return { browse, busy, error, open, close: () => setBrowse(undefined) };
}

function FolderList({
  browse,
  root,
  onOpen,
  choose,
}: {
  browse: ProjectsBrowseResult;
  /** Browsing stays inside this folder ("Add folder…"). */
  root?: string;
  onOpen: (path: string) => void;
  choose?: { title: string; disabled?: boolean; onPress: () => void };
}) {
  const atRoot = !!root && browse.path === root;
  return (
    <View style={{ marginTop: 8 }}>
      <T variant="caption" tone="secondary" selectable>
        Folders in {browse.path}
      </T>
      {choose && !choose.disabled && <Row title={choose.title} icon="checkmark" onPress={choose.onPress} />}
      {browse.parent && !atRoot && <Row title="Parent folder" icon="arrow.up" onPress={() => onOpen(browse.parent!)} />}
      {browse.directories.map((d) => (
        <Row key={d.path} title={d.name} icon="folder" onPress={() => onOpen(d.path)} />
      ))}
      {!browse.directories.length && (
        <T tone="secondary" style={{ marginTop: 12 }}>
          No subfolders here.
        </T>
      )}
      {browse.has_more && (
        <T variant="caption" tone="secondary">
          Enter a folder path above to find more folders.
        </T>
      )}
    </View>
  );
}

export default function AddProject() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const group = projectId ? app.projects.find((p) => p.id === projectId) : undefined;
  const [kind, setKind] = useState<Kind>(projectId ? "group" : "single");
  const groups = supportsGroupProjects();
  if (projectId)
    return (
      <>
        <Stack.Screen options={{ title: GROUP_COPY.addRepositories.replace("…", "") }} />
        {group ? (
          <GroupForm existing={group} />
        ) : (
          <Page>
            <T tone="secondary">This project is no longer on your computer.</T>
          </Page>
        )}
      </>
    );
  const picker = groups ? (
    <Segmented
      label="Project type"
      value={kind}
      onChange={setKind}
      options={[
        { value: "single", label: "One repository" },
        { value: "group", label: "Group of repositories" },
      ]}
    />
  ) : null;
  return kind === "group" ? <GroupForm header={picker} /> : <SingleForm header={picker} />;
}

function SingleForm({ header }: { header: React.ReactNode }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const folders = useBrowse();
  async function directories(next?: string) {
    const result = await folders.open(next);
    if (result) setPath(result.path);
  }
  useEffect(() => {
    void directories();
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
      {header}
      <Animated.View entering={header ? swap : undefined}>
        <T tone="secondary" style={{ marginTop: header ? 14 : 0, marginBottom: 24 }}>
          Choose an existing folder on your computer. It will also appear in the desktop app.
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
          <Button secondary busy={busy || folders.busy} onPress={() => void directories(path)}>
            Browse folder
          </Button>
          <Field label="Project name (optional)" value={name} onChangeText={setName} placeholder="Use folder name" />
          <ErrorBanner error={error || folders.error} />
          <Button busy={busy} disabled={!path.trim()} onPress={() => void add()}>
            Add this folder
          </Button>
        </View>
        {folders.browse && (
          <View style={{ marginTop: 16 }}>
            <FolderList browse={folders.browse} onOpen={(next) => void directories(next)} />
          </View>
        )}
      </Animated.View>
    </Page>
  );
}

/**
 * A group project, or more repositories for an existing one (`existing`). The
 * checklist starts empty: Kybern never picks repositories for the user.
 */
function GroupForm({ header, existing }: { header?: React.ReactNode; existing?: { id: string; name: string; path: string; members?: { path: string }[] } }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [folder, setFolder] = useState(existing?.path ?? "");
  const [scan, setScan] = useState<ProjectsScanReposResult>();
  const [include, setInclude] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState<"folder" | "add" | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const folders = useBrowse();
  const scanRequest = useRef(0);
  const memberPaths = new Set(existing?.members?.map((member) => member.path) ?? []);

  async function look(path: string, extra: string[] = include) {
    if (!path.trim()) return;
    const id = ++scanRequest.current;
    setScanning(true);
    setError("");
    try {
      const result = await rpc("projects.scan_repos", { path: path.trim(), ...(extra.length ? { include: extra } : {}) });
      if (id !== scanRequest.current) return;
      setScan(result);
      setFolder(result.path);
      const selectable = new Set(result.candidates.filter((c) => !c.submodule_of && !memberPaths.has(c.path)).map((c) => c.path));
      // Folders picked with "Add folder…" are an explicit choice; scanned ones stay unticked.
      const added = result.candidates.filter((c) => c.added && selectable.has(c.path)).map((c) => c.path);
      setSelected((current) => orderMemberPaths([...current.filter((p) => selectable.has(p)), ...added]));
    } catch (e) {
      if (id === scanRequest.current) setError(errorText(e));
    } finally {
      if (id === scanRequest.current) setScanning(false);
    }
  }
  useEffect(() => {
    if (existing) void look(existing.path, []);
  }, [existing?.id]);

  function chooseFolder(path: string) {
    setBrowsing(null);
    folders.close();
    setInclude([]);
    setSelected([]);
    void look(path, []);
  }
  function addFolder(path: string) {
    setBrowsing(null);
    folders.close();
    const next = [...new Set([...include, path])];
    setInclude(next);
    void look(scan?.path ?? folder, next);
  }

  const candidates = (scan?.candidates ?? []).filter((c) => !memberPaths.has(c.path));
  const selectable = candidates.filter((c) => !c.submodule_of);
  const allSelected = existing ? [...memberPaths, ...selected] : selected;
  const blocked = existing ? (selected.length ? null : "Select a repository to add.") : memberSelectionError(selected);
  const helper = existing
    ? selected.length
      ? `New chats get ${selected.length === 1 ? "it" : "them"}; existing chats keep the repositories they started with.`
      : "Select the repositories to add."
    : memberSelectionHelper(selected);
  const duplicate = !existing && scan?.existing_project_id ? scan.existing_project_id : null;

  async function submit() {
    if (!scan || blocked || duplicate) return;
    setAdding(true);
    setError("");
    try {
      if (existing) {
        await rpc("projects.update", { project_id: existing.id, members: orderMemberPaths(allSelected) });
        await refresh();
        router.back();
      } else {
        const project = await rpc("projects.add", { path: scan.path, kind: "group", members: orderMemberPaths(selected) });
        await refresh();
        setDraft({ projectId: project.id, baseBranch: "" });
        router.dismissTo("/");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Page>
        {header}
        <Animated.View entering={header ? swap : undefined}>
          <T variant="caption" tone="secondary" style={{ marginTop: header ? 14 : 0 }}>
            {existing ? GROUP_COPY.addRepositoriesBody(existing.path) : GROUP_COPY.newGroupSubtitleMobile}
          </T>
          {!existing && (
            <>
              <T variant="label" style={{ marginTop: 20, marginBottom: 8 }}>
                {GROUP_COPY.groupFolder}
              </T>
              <View
                style={[
                  styles.line,
                  {
                    minHeight: 52,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: colors.line,
                    backgroundColor: colors.surface,
                    paddingStart: 15,
                    paddingEnd: 4,
                  },
                ]}
              >
                <TextInput
                  underlineColorAndroid="transparent"
                  accessibilityLabel={GROUP_COPY.groupFolder}
                  value={folder}
                  onChangeText={setFolder}
                  onSubmitEditing={() => chooseFolder(folder)}
                  returnKeyType="search"
                  autoCorrect={false}
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="~/work/acme"
                  placeholderTextColor={colors.muted}
                  selectionColor={colors.accent}
                  // No body line height: iOS drops a single-line input's baseline under it and clips descenders.
                  style={{
                    flex: 1,
                    alignSelf: "stretch",
                    color: colors.ink,
                    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
                    fontSize: 15,
                    letterSpacing: 0,
                  }}
                />
                <Tap
                  label="Browse folders"
                  onPress={() => {
                    if (browsing === "folder") {
                      setBrowsing(null);
                      folders.close();
                      return;
                    }
                    setBrowsing("folder");
                    void folders.open(folder.trim() || undefined);
                  }}
                  style={{ paddingHorizontal: 12, alignItems: "center" }}
                >
                  <T variant="label" tone="accent">
                    {GROUP_COPY.browse}
                  </T>
                </Tap>
              </View>
              {browsing === "folder" && folders.browse && (
                <FolderList
                  browse={folders.browse}
                  onOpen={(path) => void folders.open(path)}
                  choose={{ title: "Use this folder", onPress: () => chooseFolder(folders.browse!.path) }}
                />
              )}
            </>
          )}
          <ErrorBanner error={error || folders.error} onRetry={error && folder ? () => void look(folder) : undefined} />
          {duplicate && (
            <View style={[styles.spread, { marginTop: 16 }]}>
              <T variant="label" tone="warning" style={{ flex: 1 }}>
                {GROUP_COPY.alreadyProject(scan!.name)}
              </T>
              <Tap
                label={GROUP_COPY.openIt}
                onPress={() => {
                  setDraft({ projectId: duplicate, baseBranch: "" });
                  router.dismissTo("/");
                }}
              >
                <T variant="label" tone="accent">
                  {GROUP_COPY.openIt}
                </T>
              </Tap>
            </View>
          )}
          {scanning && !scan && (
            <T variant="caption" tone="secondary" style={{ marginTop: 20 }}>
              {GROUP_COPY.scanning(folder.split("/").filter(Boolean).pop() ?? folder)}
            </T>
          )}
          {scan && (
            <View style={{ marginTop: 20 }}>
              <View style={[styles.spread, { marginBottom: 4 }]}>
                <T variant="caption" tone="secondary">
                  {scanning ? GROUP_COPY.scanning(scan.name) : `Repositories in ${scan.name}`}
                </T>
                {!!selectable.length && (
                  <T variant="caption" tone="secondary" style={{ fontVariant: ["tabular-nums"] }}>
                    {selectedCountLabel(selected.length, selectable.length)}
                  </T>
                )}
              </View>
              {!candidates.length && (
                <View style={{ gap: 4, paddingVertical: 12 }}>
                  <T variant="label">
                    {existing ? `Every repository in ${scan.name} is already in the group` : GROUP_COPY.nothingFoundTitle(scan.name)}
                  </T>
                  <T variant="caption" tone="secondary">
                    {GROUP_COPY.nothingFoundBody}
                  </T>
                </View>
              )}
              {candidates.map((candidate) => (
                <CheckRow
                  key={candidate.path}
                  title={candidate.path === "." ? `${candidate.name} (${GROUP_COPY.groupFolderItself})` : candidate.name}
                  detail={candidate.submodule_of ? GROUP_COPY.submoduleOf(candidate.submodule_of) : candidateDetail(candidate) || undefined}
                  checked={selected.includes(candidate.path)}
                  disabled={!!candidate.submodule_of}
                  onToggle={() => setSelected((current) => toggleCandidate(current, candidate.path))}
                />
              ))}
              {scan.rejected?.map((item) => (
                <T key={item.path} variant="caption" tone="warning" style={{ marginTop: 6 }}>
                  {item.reason}
                </T>
              ))}
              {scan.truncated && (
                <T variant="caption" tone="secondary" style={{ marginTop: 6 }}>
                  Kybern stopped looking after 200 repositories. Use {GROUP_COPY.addFolder} for one it didn’t reach.
                </T>
              )}
              <Tap
                label={GROUP_COPY.addFolder}
                onPress={() => {
                  if (browsing === "add") {
                    setBrowsing(null);
                    folders.close();
                    return;
                  }
                  setBrowsing("add");
                  void folders.open(scan.path);
                }}
                style={[styles.line, { gap: 14, minHeight: 52, justifyContent: "flex-start" }]}
              >
                <View style={{ width: 24, alignItems: "center" }}>
                  <Icon name="folder.badge.plus" size={20} color={colors.accent} />
                </View>
                <T variant="label" tone="accent">
                  {GROUP_COPY.addFolder}
                </T>
              </Tap>
              {browsing === "add" && folders.browse && (
                <FolderList
                  browse={folders.browse}
                  root={scan.path}
                  onOpen={(path) => void folders.open(path)}
                  choose={{
                    title: "Add this folder",
                    disabled: folders.browse.path === scan.path,
                    onPress: () => addFolder(folders.browse!.path),
                  }}
                />
              )}
            </View>
          )}
        </Animated.View>
      </Page>
      {scan && (
        <View style={{ paddingHorizontal: 24, paddingTop: 10, paddingBottom: insets.bottom + 12, backgroundColor: colors.background, gap: 10 }}>
          <T variant="caption" tone={blocked && selected.length ? "warning" : "secondary"} style={{ textAlign: "center" }} accessibilityLiveRegion="polite">
            {helper}
          </T>
          <View style={{ width: "100%", maxWidth: 712, alignSelf: "center" }}>
            <Button busy={adding} disabled={!!blocked || !!duplicate || scanning} onPress={() => void submit()}>
              {existing ? (selected.length ? GROUP_COPY.addRepositoriesButton(selected.length) : "Add repositories") : GROUP_COPY.addGroup}
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
