import { AppUpdatesSettings } from "../src/features/settings/AppUpdates";
import { Page } from "../src/ui/primitives";

export default function AppUpdatesScreen() {
  return (
    <Page grouped>
      <AppUpdatesSettings />
    </Page>
  );
}
