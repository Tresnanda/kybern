import { Stack } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  LinearTransition,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import {
  MorphingBackdrop,
  MorphingSurface,
} from "../components/liquid/MorphingSurface";
import { IconButton, T } from "./primitives";
import { useTheme } from "./theme";
import { SHEET } from "../components/liquid/motion";

const DETENT = LinearTransition.springify().duration(300).dampingRatio(0.8);

type ScreenLayoutProps = Parameters<
  NonNullable<ComponentProps<typeof Stack>["screenLayout"]>
>[0];
type HeaderProps = Pick<
  ScreenLayoutProps,
  "options" | "navigation" | "route"
> & { sheet?: boolean; expanded?: boolean; onExpand?: () => void };

function useRouteFocused({
  navigation,
  route,
}: Pick<ScreenLayoutProps, "navigation" | "route">) {
  const subscribe = useCallback(
    (notify: () => void) => navigation.addListener("state", notify),
    [navigation],
  );
  const snapshot = useCallback(() => {
    const state = navigation.getState();
    return state.routes[state.index]?.key === route.key;
  }, [navigation, route.key]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function AndroidHeader({
  options,
  navigation,
  route,
  sheet = false,
  expanded,
  onExpand,
}: HeaderProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useRouteFocused({ navigation, route });
  const canGoBack = navigation.canGoBack();
  const title =
    typeof options.headerTitle === "string"
      ? options.headerTitle
      : (options.title ?? route.name);
  const itemProps = { tintColor: colors.ink, canGoBack };
  return (
    <View
      importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
      style={{
        paddingTop: sheet ? 8 : insets.top,
        paddingHorizontal: 16,
        backgroundColor: sheet ? "transparent" : colors.background,
      }}
    >
      <View
        style={{
          minHeight: 60,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        {options.headerLeft ? (
          options.headerLeft(itemProps)
        ) : canGoBack && !sheet ? (
          <IconButton
            name="arrow.left"
            label="Go back"
            onPress={() => navigation.goBack()}
          />
        ) : null}
        <View style={{ flex: 1, paddingVertical: 12 }}>
          {typeof options.headerTitle === "function" ? (
            options.headerTitle({ children: title, tintColor: colors.ink })
          ) : (
            <T variant="heading" accessibilityRole="header">
              {title}
            </T>
          )}
        </View>
        {onExpand && (
          <IconButton
            name={expanded ? "chevron.down" : "chevron.up"}
            label={expanded ? "Make sheet smaller" : "Expand sheet"}
            onPress={onExpand}
          />
        )}
        {options.headerRight?.(itemProps)}
        {sheet && !options.headerRight && (
          <IconButton
            name="xmark"
            label="Close sheet"
            onPress={() => navigation.goBack()}
          />
        )}
      </View>
    </View>
  );
}

export function AndroidSheet({ children, ...props }: ScreenLayoutProps) {
  const insets = useSafeAreaInsets();
  const focused = useRouteFocused(props);
  const [open, setOpen] = useState(true);
  const [allowRemove, setAllowRemove] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotion();
  const drag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const releaseVelocity = useSharedValue(0);
  const pending = useRef<
    Parameters<typeof props.navigation.dispatch>[0] | null
  >(null);
  usePreventRemove(!allowRemove, ({ data }) => {
    if (pending.current) return;
    pending.current = data.action;
    setOpen(false);
  });
  const closed = useCallback(() => setAllowRemove(true), []);
  const expand = useCallback(() => setExpanded(true), []);
  const dismiss = useCallback(
    () => props.navigation.goBack(),
    [props.navigation],
  );
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(open)
        .activeOffsetY([-10, 10])
        .onStart(() => {
          cancelAnimation(drag);
          releaseVelocity.set(0);
          dragStart.set(drag.get());
        })
        .onUpdate((event) => {
          const next = dragStart.get() + event.translationY;
          drag.set(next >= 0 ? next : next / (3 + Math.abs(next) / 100));
        })
        .onEnd((event) => {
          releaseVelocity.set(event.velocityY);
          if (event.translationY < -80 || event.velocityY < -900) {
            scheduleOnRN(expand);
            drag.set(
              withSpring(0, {
                ...SHEET,
                velocity: event.velocityY,
              }),
            );
          } else if (
            drag.get() > 120 ||
            (drag.get() > 12 && event.velocityY > 900)
          ) {
            scheduleOnRN(dismiss);
          } else {
            drag.set(
              withSpring(0, {
                ...SHEET,
                velocity: event.velocityY,
              }),
            );
          }
        })
        .onFinalize((_event, success) => {
          if (!success) drag.set(withSpring(0, SHEET));
        }),
    [open, drag, dragStart, releaseVelocity, dismiss, expand],
  );
  useEffect(() => {
    if (allowRemove && pending.current)
      props.navigation.dispatch(pending.current);
  }, [allowRemove, props.navigation]);
  const detents = props.options.sheetAllowedDetents;
  const compactHeight =
    Array.isArray(detents) && typeof detents[0] === "number" ? detents[0] : 0.9;
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <View
        importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
        style={{
          flex: 1,
          paddingTop: insets.top + 24,
          paddingHorizontal: 12,
          paddingBottom: Math.max(insets.bottom, 12),
          justifyContent: "flex-end",
        }}
        accessibilityViewIsModal
      >
        <MorphingBackdrop open={open} onPress={dismiss} label="Dismiss sheet" />
        <Animated.View
          layout={reduced ? undefined : DETENT}
          style={[
            {
              height: `${Math.round((expanded ? 1 : compactHeight) * 100)}%`,
              width: "100%",
              maxWidth: 760,
              alignSelf: "center",
            },
          ]}
        >
          <MorphingSurface
            open={open}
            onClosed={closed}
            slideFromBottom
            bottomInset={Math.max(insets.bottom, 12)}
            offset={drag}
            releaseVelocity={releaseVelocity}
            style={{ flex: 1 }}
          >
            <GestureDetector gesture={gesture}>
              <View collapsable={false}>
                <AndroidHeader
                  {...props}
                  sheet
                  expanded={expanded}
                  onExpand={() => setExpanded((value) => !value)}
                />
              </View>
            </GestureDetector>
            {children}
          </MorphingSurface>
        </Animated.View>
      </View>
    </KeyboardAvoidingView>
  );
}

function AndroidScene({ children, ...props }: ScreenLayoutProps) {
  const focused = useRouteFocused(props);
  return (
    <View
      style={{ flex: 1 }}
      importantForAccessibility={focused ? "auto" : "no-hide-descendants"}
    >
      {children}
    </View>
  );
}

export function androidScreenLayout(props: ScreenLayoutProps) {
  return props.options.presentation === "transparentModal" ? (
    <AndroidSheet {...props} />
  ) : (
    <AndroidScene {...props} />
  );
}
