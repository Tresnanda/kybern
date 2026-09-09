import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  ReduceMotion,
  Easing,
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Button, ErrorBanner, Icon, T, Tap } from "../ui/primitives";
import { useTheme } from "../ui/theme";
import type { SendRect } from "../state/sendTransition";
import { errorText } from "../state/runtime";

// The camera and captured image share a measured rectangle. Only the silhouette
// changes bounds; controls stay at their final size and the photo keeps its ratio.
export function ComposerCamera({
  origin,
  onAttach,
  onClosed,
}: {
  origin: SendRect;
  onAttach: (uri: string) => Promise<SendRect | null>;
  onClosed: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  const [ready, setReady] = useState(false);
  const [facing, setFacing] = useState<"back" | "front">("back");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoAspect, setPhotoAspect] = useState(1);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const camera = useRef<CameraView>(null);
  const locked = useRef(false);
  const alive = useRef(true);
  const position = useSharedValue(0);
  const outline = useSharedValue(0);
  const fade = useSharedValue(0);
  const flight = useSharedValue(0);
  const dismissal = useSharedValue(0);
  const destination = useSharedValue<SendRect | null>(null);
  const previewWidth = Math.min(width - 24, 440);
  const previewHeight = Math.min(
    previewWidth * 1.32,
    (height - insets.top - insets.bottom) * 0.62,
  );
  const preview = {
    x: (width - previewWidth) / 2,
    y: height - Math.max(insets.bottom, 12) - previewHeight - 8,
    width: previewWidth,
    height: previewHeight,
  };
  useEffect(() => {
    alive.current = true;
    const listener = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
      setReady(false);
      if (state === "active")
        void getPermission().catch((e) => setError(errorText(e)));
    });
    return () => {
      alive.current = false;
      listener.remove();
    };
  }, [getPermission]);
  const show = () => {
    position.set(withSpring(1, { duration: 400, dampingRatio: 1 }));
    outline.set(withSpring(1, { duration: 400, dampingRatio: 0.8 }));
    fade.set(
      withTiming(1, { duration: 140, reduceMotion: ReduceMotion.Never }),
    );
  };
  const close = useCallback(() => {
    if (locked.current) return;
    locked.current = true;
    setClosing(true);
    cancelAnimation(position);
    cancelAnimation(outline);
    if (!reduced)
      dismissal.set(
        withTiming(
          1,
          { duration: 260, easing: Easing.bezier(0.32, 0.72, 0, 1) },
          (done) => {
            if (done) scheduleOnRN(onClosed);
          },
        ),
      );
    fade.set(
      withTiming(
        0,
        { duration: 140, reduceMotion: ReduceMotion.Never },
        (done) => {
          if (done && reduced) scheduleOnRN(onClosed);
        },
      ),
    );
  }, [position, outline, dismissal, fade, reduced, onClosed]);
  async function capture() {
    if (locked.current || !ready || !foreground) return;
    locked.current = true;
    setBusy(true);
    setError("");
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const result = await camera.current?.takePictureAsync({ quality: 0.85 });
      if (!result) throw new Error("Unable to take a photo. Try again.");
      if (alive.current) {
        setPhotoAspect(result.width / result.height);
        setPhoto(result.uri);
      }
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function usePhoto() {
    if (!photo || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const rect = await onAttach(photo);
      if (!alive.current) return;
      destination.set(rect);
      setClosing(true);
      if (reduced || !rect) {
        fade.set(
          withTiming(
            0,
            { duration: 140, reduceMotion: ReduceMotion.Never },
            (done) => {
              if (done) scheduleOnRN(onClosed);
            },
          ),
        );
        return;
      }
      fade.set(
        withTiming(0, { duration: 140, reduceMotion: ReduceMotion.Never }),
      );
      // The destination is the actual laid-out thumbnail, including composer reflow.
      flight.set(
        withSpring(1, { duration: 400, dampingRatio: 1 }, (done) => {
          if (done) scheduleOnRN(onClosed);
        }),
      );
    } catch (e) {
      locked.current = false;
      if (alive.current) {
        setError(errorText(e));
        setBusy(false);
      }
    }
  }
  const chrome = useAnimatedStyle(() => ({ opacity: fade.get() }));
  const surface = useAnimatedStyle(() => {
    const p = reduced ? 1 : position.get();
    const s = reduced ? 1 : Math.max(0, outline.get());
    const w = origin.width + (preview.width - origin.width) * s;
    const h = origin.height + (preview.height - origin.height) * s;
    const y =
      origin.y + origin.height / 2 +
      (preview.y + preview.height / 2 - origin.y - origin.height / 2) * p - h / 2;
    return {
      width: w,
      height: h,
      opacity: destination.get()
        ? 0
        : reduced || (closing && busy && photo)
          ? fade.get()
          : 1,
      borderRadius: 36 + Math.sin(Math.PI * Math.min(1, s)) * 12,
      transform: [
        {
          translateX:
            origin.x +
            origin.width / 2 +
            (preview.x + preview.width / 2 - origin.x - origin.width / 2) * p -
            w / 2,
        },
        {
          translateY: y + dismissal.get() * (height - y + 16),
        },
      ],
    };
  });
  const photoFlight = useAnimatedStyle(() => {
    const to = destination.get();
    const p = reduced ? 1 : flight.get();
    return {
      opacity: to && !reduced ? 1 : 0,
      width: preview.width + ((to?.width ?? preview.width) - preview.width) * p,
      height:
        preview.height + ((to?.height ?? preview.height) - preview.height) * p,
      borderRadius: interpolate(p, [0, 1], [36, 16]),
      transform: [
        { translateX: preview.x + ((to?.x ?? preview.x) - preview.x) * p },
        { translateY: preview.y + ((to?.y ?? preview.y) - preview.y) * p },
      ],
    };
  });
  const flightImage = useAnimatedStyle(() => {
    const to = destination.get();
    const p = flight.get();
    const w =
      preview.width + ((to?.width ?? preview.width) - preview.width) * p;
    const h =
      preview.height + ((to?.height ?? preview.height) - preview.height) * p;
    // Keep cover framing continuous as the preview becomes a compact photo tile.
    const imageHeight = Math.max(h, w / photoAspect);
    return {
      width: imageHeight * photoAspect,
      height: imageHeight,
      left: (w - imageHeight * photoAspect) / 2,
      top: (h - imageHeight) / 2,
    };
  });
  return (
    <Modal
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      hardwareAccelerated
      onShow={show}
      onRequestClose={close}
    >
      <View
        style={{ flex: 1 }}
        accessibilityViewIsModal
        onAccessibilityEscape={close}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close camera"
          disabled={busy}
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          style={[
            {
              position: "absolute",
              top: 0,
              left: 0,
              overflow: "hidden",
              borderCurve: "continuous",
              backgroundColor: colors.raised,
            },
            surface,
          ]}
        >
          <View style={{ width: preview.width, height: preview.height }}>
            {photo ? (
              <Image
                source={{ uri: photo }}
                resizeMode="cover"
                style={StyleSheet.absoluteFill}
              />
            ) : permission?.granted && foreground ? (
              <CameraView
                ref={camera}
                style={StyleSheet.absoluteFill}
                facing={facing}
                mode="picture"
                onCameraReady={() => setReady(true)}
                onMountError={() =>
                  setError("Unable to open the camera. Close it and try again.")
                }
              />
            ) : null}
            <Animated.View
              pointerEvents={closing ? "none" : "auto"}
              style={[
                {
                  position: "absolute",
                  bottom: 0,
                  left: 0,
                  right: 0,
                  maxHeight: preview.height,
                  padding: 20,
                  backgroundColor:
                    photo || !permission?.granted || error
                      ? "#181818E8"
                      : "transparent",
                  gap: 12,
                },
                chrome,
              ]}
            >
              <ScrollView contentContainerStyle={{ gap: 12 }} bounces={false}>
                <ErrorBanner error={error} />
                {!permission?.granted ? (
                  <>
                    <T variant="label" style={{ color: "white" }}>
                      Allow camera access to take a photo.
                    </T>
                    <Button
                      onPress={() => {
                        void (
                          permission?.canAskAgain === false
                            ? Linking.openSettings()
                            : requestPermission()
                        ).catch((e) => setError(errorText(e)));
                      }}
                    >
                      {permission?.canAskAgain === false
                        ? "Open settings"
                        : "Allow camera"}
                    </Button>
                  </>
                ) : photo ? (
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 16,
                    }}
                  >
                    <Button
                      secondary
                      disabled={busy}
                      onPress={() => {
                        setReady(false);
                        setPhoto(null);
                        setError("");
                      }}
                    >
                      Retake
                    </Button>
                    <Button busy={busy} onPress={() => void usePhoto()}>
                      Use photo
                    </Button>
                  </View>
                ) : (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Tap
                      label="Close camera"
                      onPress={close}
                      disabled={busy}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: "#00000066",
                        alignItems: "center",
                      }}
                    >
                      <Icon name="chevron.left" size={22} color="white" />
                    </Tap>
                    <Tap
                      label="Take photo"
                      disabled={!ready || busy || !foreground}
                      onPress={() => void capture()}
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 36,
                        borderWidth: 3,
                        borderColor: "white",
                        alignItems: "center",
                      }}
                    >
                      <View
                        style={{
                          width: 58,
                          height: 58,
                          borderRadius: 29,
                          backgroundColor: "white",
                        }}
                      />
                    </Tap>
                    <Tap
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: "#00000066",
                        alignItems: "center",
                      }}
                      label="Switch camera"
                      disabled={busy}
                      onPress={() => {
                        setReady(false);
                        setFacing((value) =>
                          value === "back" ? "front" : "back",
                        );
                      }}
                    >
                      <Icon
                        name="arrow.triangle.swap"
                        size={21}
                        color="white"
                      />
                    </Tap>
                  </View>
                )}
              </ScrollView>
            </Animated.View>
          </View>
        </Animated.View>
        {photo && (
          <Animated.View
            pointerEvents="none"
            style={[
              { position: "absolute", left: 0, top: 0, overflow: "hidden" },
              photoFlight,
            ]}
          >
            <Animated.Image
              source={{ uri: photo }}
              resizeMode="contain"
              style={[{ position: "absolute" }, flightImage]}
            />
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}
