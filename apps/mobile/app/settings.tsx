// Settings. Phone: a grouped list of categories, each its own page. iPad: the
// same list as a rail beside the selected page.
import Constants from "expo-constants";
import { Stack } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { appVersion } from "../src/features/settings/AppUpdates";
import {
  SettingsBody,
  TITLES,
  openCategory,
  useCategories,
  type Category,
  type CategoryId,
} from "../src/features/settings/categories";
import { useLayout } from "../src/state/layout";
import { currentClient } from "../src/state/runtime";
import { ListRow, SectionFooter, SectionHeader, InsetGroup } from "../src/ui/List";
import { Page } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, space, useTheme } from "../src/ui/theme";

const RAIL_WIDTH = 320;

function versionLine() {
  const daemon = currentClient()?.info?.version;
  return [`Kybern for mobile ${appVersion() || Constants.nativeAppVersion || ""}`.trim(), daemon ? `Kybern ${daemon} on the computer` : null]
    .filter(Boolean)
    .join(" · ");
}

function Groups({
  selected,
  onSelect,
}: {
  selected?: CategoryId;
  onSelect: (id: CategoryId) => void;
}) {
  const { phone, computer, computerName } = useCategories();
  const row = (item: Category) => (
    <ListRow
      key={item.id}
      title={item.title}
      leading={item.icon}
      // The rail marks the open page; the phone list shows values and pushes.
      value={selected ? undefined : item.value}
      selected={selected === item.id}
      chevron={!selected}
      onPress={() => onSelect(item.id)}
    />
  );
  return (
    <>
      <SectionHeader title="This phone" inset first />
      <InsetGroup>{phone.map(row)}</InsetGroup>
      <SectionHeader title={computerName} inset />
      <InsetGroup>{computer.map(row)}</InsetGroup>
      <SectionFooter inset>{versionLine()}</SectionFooter>
    </>
  );
}

export default function SettingsScreen() {
  const { colors } = useTheme();
  const { regular, width } = useLayout();
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<CategoryId>("appearance");
  if (!regular)
    return (
      <Page grouped>
        <Stack.Screen options={{ headerLargeTitleEnabled: true, headerStyle: { backgroundColor: colors.grouped } }} />
        <Groups onSelect={openCategory} />
      </Page>
    );
  const detailWidth = width - RAIL_WIDTH;
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: colors.grouped }}>
      <Stack.Screen options={{ title: TITLES[selected], headerStyle: { backgroundColor: colors.grouped } }} />
      <ScrollView
        style={{ width: RAIL_WIDTH, flexGrow: 0, borderRightWidth: 0.5, borderColor: colors.line }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space["2xl"] }}
        showsVerticalScrollIndicator={false}
      >
        <Groups selected={selected} onSelect={setSelected} />
      </ScrollView>
      <ScrollView
        key={selected}
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{
          paddingHorizontal: gutter(detailWidth),
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space["2xl"],
          width: "100%",
          maxWidth: CONTENT_MAX_WIDTH,
          alignSelf: "center",
        }}
      >
        <SettingsBody category={selected} />
      </ScrollView>
    </View>
  );
}
