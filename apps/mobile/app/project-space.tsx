import { router, Stack, useLocalSearchParams } from "expo-router";
import { ScrollView, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProjectSpace } from "../src/features/ProjectSpace";
import { useApp } from "../src/state/runtime";
import { Empty, IconButton } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";

/** The Coordinator's Project sheet: brief, setup, memory, Coordinator settings and the brief switch. */
export default function ProjectSpaceScreen() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const app = useApp();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const project = app.projects.find((item) => item.id === projectId);
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.grouped }}>
      <Stack.Screen
        options={{
          title: project?.name ?? "Project",
          headerStyle: { backgroundColor: colors.grouped },
          headerRight: () => <IconButton name="xmark" label="Close project" onPress={() => router.back()} />,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingHorizontal: gutter(width), paddingTop: space.sm, paddingBottom: insets.bottom + space["2xl"], width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center" }}
      >
        {projectId && project ? (
          <ProjectSpace projectId={projectId} />
        ) : (
          <Empty icon="folder" title="Project not found" detail="It may have been removed. Close this and open the Coordinator again." />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
