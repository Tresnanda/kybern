import { Camera, CameraView, useCameraPermissions } from "expo-camera";
import * as DocumentPicker from "expo-document-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Linking, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parsePairingInvitation } from "../src/state/protocol";
import { errorText } from "../src/state/runtime";
import { haptics } from "../src/ui/haptics";
import { Button, Empty, ErrorBanner, T } from "../src/ui/primitives";
import { CONTENT_MAX_WIDTH, gutter, radius, space, useTheme } from "../src/ui/theme";

// Point the camera at the pairing QR code on the computer, or pick a screenshot of it.
export default function ScanPairing() {
  const [permission, requestPermission] = useCameraPermissions();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
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
      setError("This isn't a Kybern invitation. Create a new QR code on your computer.");
      return;
    }
    handled.current = true;
    haptics.success();
    router.replace({ pathname: "/connect", params: { invitation: value } });
  }
  async function scanImage() {
    setError("");
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: "image/*", copyToCacheDirectory: true });
      if (result.canceled) return;
      setBusy(true);
      const codes = await Camera.scanFromURLAsync(result.assets[0].uri, ["qr"]);
      const match = codes.find((code) => parsePairingInvitation(code.data));
      if (match) accept(match.data);
      else setError("No Kybern invitation found. Choose an image that shows the whole pairing QR code.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const finder = Math.min(width - 2 * gutter(width), 360);
  const denied = permission?.canAskAgain === false;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.grouped }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: gutter(width),
        paddingTop: space.lg,
        paddingBottom: insets.bottom + space.xl,
        maxWidth: CONTENT_MAX_WIDTH,
        width: "100%",
        alignSelf: "center",
        gap: space.lg,
      }}
    >
      {permission?.granted ? (
        <>
          <View
            style={{
              width: finder,
              height: finder,
              alignSelf: "center",
              borderRadius: radius.xl,
              overflow: "hidden",
              backgroundColor: colors.raised,
            }}
          >
            {focused ? (
              <CameraView
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(result) => accept(result.data)}
              />
            ) : null}
          </View>
          <T tone="secondary" style={{ textAlign: "center" }}>
            Open the pairing invitation in Kybern on your computer, then point the camera at its QR code.
          </T>
        </>
      ) : (
        <Empty
          icon="camera"
          title={denied ? "Camera access is off" : "Allow the camera to scan"}
          detail={
            denied
              ? "Turn on camera access for Kybern in Settings, or choose a screenshot of the QR code."
              : "Kybern uses the camera only to read the pairing QR code."
          }
          action={
            <Button
              size="medium"
              icon="camera"
              onPress={() => {
                if (denied) void Linking.openSettings();
                else void requestPermission();
              }}
            >
              {denied ? "Open Settings" : "Allow camera"}
            </Button>
          }
        />
      )}
      <ErrorBanner error={error} />
      <View style={{ flexGrow: 1 }} />
      <View style={{ gap: space.sm }}>
        <Button icon="photo" busy={busy} onPress={() => void scanImage()}>
          Choose QR image
        </Button>
        <Button role="plain" onPress={() => router.back()}>
          Enter the code instead
        </Button>
      </View>
    </ScrollView>
  );
}
