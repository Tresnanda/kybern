import { Camera, CameraView, useCameraPermissions } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { parsePairingInvitation } from "../src/state/protocol";
import { errorText } from "../src/state/runtime";
import { Button, ErrorBanner, Page, T } from "../src/ui/primitives";

export default function ScanPairing() {
  const [permission, requestPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      handled.current = false;
      return () => setFocused(false);
    }, []),
  );
  function accept(value: string) {
    if (handled.current) return;
    if (!parsePairingInvitation(value)) {
      setError(
        "This is not a Kybern invitation. Create a new QR code on your computer.",
      );
      return;
    }
    handled.current = true;
    router.replace({ pathname: "/connect", params: { invitation: value } });
  }
  async function scanImage() {
    setError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      setBusy(true);
      const codes = await Camera.scanFromURLAsync(result.assets[0].uri, ["qr"]);
      const match = codes.find((code) => parsePairingInvitation(code.data));
      if (match) accept(match.data);
      else
        setError(
          "No Kybern invitation found. Choose an image containing the full pairing QR code.",
        );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page>
      <T variant="title">Scan to connect</T>
      <T tone="secondary" style={{ marginTop: 12, marginBottom: 24 }}>
        Open the pairing invitation in Kybern on your computer, then point your
        camera at its QR code.
      </T>
      {permission?.granted && focused ? (
        <View
          style={{
            aspectRatio: 1,
            borderRadius: 24,
            overflow: "hidden",
            backgroundColor: "#181818",
          }}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={(result) => accept(result.data)}
          />
        </View>
      ) : (
        <Button
          icon="camera"
          onPress={() => {
            if (permission?.canAskAgain === false) void Linking.openSettings();
            else void requestPermission();
          }}
        >
          {permission?.canAskAgain === false
            ? "Open camera settings"
            : "Allow camera"}
        </Button>
      )}
      <ErrorBanner error={error} />
      <View style={{ gap: 12, marginTop: 24 }}>
        <Button
          secondary
          icon="photo"
          busy={busy}
          onPress={() => void scanImage()}
        >
          Choose QR image
        </Button>
        <Button secondary onPress={() => router.back()}>
          Enter code manually
        </Button>
      </View>
    </Page>
  );
}
