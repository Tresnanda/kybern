import { Stack } from "expo-router";
import { MachinesSettings } from "../src/features/settings/Machines";
import { Page } from "../src/ui/primitives";
import { useTheme } from "../src/ui/theme";

export default function Machines() {
  const { colors } = useTheme();
  return (
    <Page grouped>
      <Stack.Screen options={{ title: "Machines", headerStyle: { backgroundColor: colors.grouped } }} />
      <MachinesSettings />
    </Page>
  );
}
