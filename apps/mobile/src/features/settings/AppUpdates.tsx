import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useState } from "react";
import { View } from "react-native";
import { confirm } from "../../ui/Alert";
import { ListRow } from "../../ui/List";
import { Button, ErrorBanner } from "../../ui/primitives";
import { space } from "../../ui/theme";
import { Section } from "./common";

export const appVersion = () =>
  Constants.expoConfig?.version ?? Constants.nativeAppVersion ?? "";

export function AppUpdatesSettings() {
  const { isChecking, isDownloading, isUpdatePending } = Updates.useUpdates();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState(false);
  async function check() {
    setBusy(true);
    setChecked(false);
    setError("");
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable || result.isRollBackToEmbedded)
        await Updates.fetchUpdateAsync();
      setChecked(true);
    } catch {
      setError("Unable to check for updates. Check your internet connection and try again.");
    } finally {
      setBusy(false);
    }
  }
  const restart = () =>
    confirm({
      title: "Restart to update?",
      message: "Finish or copy any unsent message first. Work on your computer will continue.",
      confirm: "Restart",
      destructive: false,
      onConfirm: () => {
        void Updates.reloadAsync().catch(() =>
          setError("Unable to restart. Close and reopen Kybern to apply the update."),
        );
      },
    });
  const status = !Updates.isEnabled
    ? "Release builds only"
    : isUpdatePending
      ? "Update ready"
      : isDownloading
        ? "Downloading…"
        : busy || isChecking
          ? "Checking…"
          : checked
            ? "Up to date"
            : undefined;
  return (
    <>
      <Section
        title="Kybern on this phone"
        first
        footer={
          !Updates.isEnabled
            ? "App updates are available in an installed Kybern release build."
            : "Updates download in the background when Kybern starts and apply the next time you open it."
        }
      >
        <ListRow title="Version" value={appVersion()} />
        {status ? <ListRow title="Status" value={status} /> : null}
      </Section>
      {Updates.isEnabled ? (
        <View style={{ marginTop: space.xl }}>
          {isUpdatePending ? (
            <Button role="prominent" icon="arrow.clockwise" onPress={restart}>
              Restart to update
            </Button>
          ) : (
            <Button
              icon="arrow.clockwise"
              busy={busy || isChecking || isDownloading}
              onPress={() => void check()}
            >
              Check for updates
            </Button>
          )}
        </View>
      ) : null}
      <ErrorBanner error={error} onRetry={() => void check()} />
    </>
  );
}
