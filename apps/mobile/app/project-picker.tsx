import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { isGroupProject } from "../../../packages/kybern-client/src/groups";
import { setDraft, useDraft } from "../src/state/draft";
import { homeOf, shortPath } from "../src/state/projectList";
import { isFreeChatProject } from "../src/state/protocol";
import { currentClient } from "../src/state/runtime";
import { useSpaceProjects } from "../src/state/spaces";
import { InsetGroup, ListRow } from "../src/ui/List";
import { Button, Empty } from "../src/ui/primitives";
import { SearchField } from "../src/ui/Search";
import { gutter, space, useTheme } from "../src/ui/theme";

// Choose the project a new thread starts in (the active space's projects).
export default function ProjectPicker() {
  const projects = useSpaceProjects().filter((p) => !isFreeChatProject(p.id));
  const draft = useDraft();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const home = homeOf(currentClient()?.info?.data_dir);
  const needle = query.trim().toLowerCase();
  const shown = projects.filter((p) => `${p.name} ${p.path}`.toLowerCase().includes(needle));
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: gutter(width), gap: space.lg, flexGrow: 1 }}
    >
      <SearchField value={query} onChangeText={setQuery} placeholder="Search projects" />
      {shown.length ? (
        <InsetGroup>
          {shown.map((p) => (
            <ListRow
              key={p.id}
              title={p.name}
              subtitle={shortPath(p.path, home)}
              subtitleLines={1}
              subtitleEllipsize="middle"
              leading={isGroupProject(p) ? "square.stack.3d.up" : "folder"}
              checked={p.id === draft.projectId}
              onPress={() => {
                setDraft({ projectId: p.id, baseBranch: "" });
                router.back();
              }}
            />
          ))}
        </InsetGroup>
      ) : (
        <Empty
          icon="folder"
          title={needle ? `No projects match “${query.trim()}”` : "Add your first project"}
          detail="Choose a folder on your computer."
        />
      )}
      <View>
        <Button icon="plus" onPress={() => router.push("/add-project")}>
          Add project
        </Button>
      </View>
    </ScrollView>
  );
}
