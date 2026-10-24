import { Stack, useLocalSearchParams } from "expo-router";
import { SettingsBody, TITLES, categoryOf } from "../src/features/settings/categories";
import { Page } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function SettingsDetail() {
  const { colors } = useTheme();
  const category = categoryOf(useLocalSearchParams<{ category?: string }>().category);
  return (
    <Page grouped>
      <Stack.Screen options={{ title: TITLES[category], headerStyle: { backgroundColor: colors.grouped } }} />
      <SettingsBody category={category} />
    </Page>
  );
}
