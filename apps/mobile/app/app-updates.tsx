import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useState } from "react";
import { Alert } from "react-native";
import { Button, ErrorBanner, Group, Page, Row, T } from "../src/ui/primitives";

export default function AppUpdatesScreen() {
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
      setError(
        "Unable to check for updates. Check your internet connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function restart() {
    Alert.alert(
      "Restart to update?",
      "Finish or copy any unsent message first. Work on your computer will continue.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Restart",
          onPress: () => {
            void Updates.reloadAsync().catch(() =>
              setError(
                "Unable to restart. Close and reopen Kybern to apply the update.",
              ),
            );
          },
        },
      ],
    );
  }
  return (
    <Page>
      <Group title="Kybern on this phone">
        <Row
          title="Version"
          trailing={
            <T variant="caption">
              {Constants.expoConfig?.version ?? Constants.nativeAppVersion}
            </T>
          }
        />
        <T tone="secondary">
          Updates download in the background when Kybern starts and apply the
          next time you open it. Your conversation stays open while you work.
        </T>
        {!Updates.isEnabled ? (
          <T tone="secondary">
            App updates are available in an installed Kybern release build.
          </T>
        ) : isUpdatePending ? (
          <>
            <T>Update ready. Restart Kybern to use it.</T>
            <Button icon="arrow.clockwise" onPress={restart}>
              Restart to update
            </Button>
          </>
        ) : (
          <>
            {checked && <T tone="secondary">You’re up to date.</T>}
            <Button
              icon="arrow.clockwise"
              disabled={busy || isChecking || isDownloading}
              onPress={() => void check()}
            >
              {isDownloading
                ? "Downloading update…"
                : busy || isChecking
                  ? "Checking…"
                  : "Check for updates"}
            </Button>
          </>
        )}
        <ErrorBanner error={error} onRetry={() => void check()} />
      </Group>
    </Page>
  );
}
