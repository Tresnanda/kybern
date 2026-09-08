import MaskedView from '@react-native-masked-view/masked-view';
import {
  BlurView,
  type BlurMethod,
  type BlurTint,
  type BlurViewProps,
} from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import {
  StyleSheet,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type GradientColors = readonly [ColorValue, ColorValue, ColorValue];
export type ProgressiveBlurEdge = 'top' | 'bottom';

const DEFAULT_BAR_HEIGHT = 58;
const DEFAULT_SPILL = 16;
const DEFAULT_FALLOFF = 64;
const DEFAULT_REVEAL_DISTANCE = 24;

export type ProgressiveBlurProps = {
  /**
   * Total backdrop height in React Native points, including the fade.
   */
  height: number;
  /**
   * Distance from the strongest edge where the blur begins fading.
   * Defaults to 64 points before the opposite edge.
   */
  fadeStart?: number;
  /**
   * Edge where the blur is strongest.
   */
  edge?: ProgressiveBlurEdge;
  /**
   * Legacy alias for edge.
   * @deprecated Use edge.
   */
  direction?: ProgressiveBlurEdge;
  /**
   * Total native blur strength from 1 to 100.
   */
  intensity?: number;
  /**
   * Number of public native blur layers used to approximate variable blur.
   * Values are clamped from 1 to 6. Defaults to 6.
   */
  layers?: number;
  /**
   * Expo blur material. Defaults to the adaptive system ultra-thin material.
   */
  tint?: BlurTint;
  /**
   * Optional color gradient drawn over the blur. No overlay is rendered by
   * default, so the backdrop keeps its original colors.
   */
  overlayColors?: GradientColors | null;
  /**
   * Android blur target. Wrap the content behind this component in
   * BlurTargetView and pass its ref here to enable native Android blur.
   */
  blurTarget?: BlurViewProps['blurTarget'];
  /**
   * Android blur implementation. When blurTarget is present this defaults to
   * dimezisBlurViewSdk31Plus.
   */
  blurMethod?: BlurMethod;
  style?: StyleProp<ViewStyle>;
};

/**
 * Public-API progressive backdrop blur. Render it after the content it should
 * sample. Most apps should use ProgressiveBlurHeader or ProgressiveBlurFooter,
 * which calculate safe areas and fade geometry automatically.
 */
export function ProgressiveBlur({
  height,
  fadeStart = height - DEFAULT_FALLOFF,
  edge,
  direction,
  intensity = 70,
  layers = 6,
  tint = 'systemUltraThinMaterial',
  overlayColors,
  blurTarget,
  blurMethod,
  style,
}: ProgressiveBlurProps) {
  const resolvedEdge = edge ?? direction ?? 'top';
  const layerCount = clamp(Math.round(layers), 1, 6);
  const layerIntensity = clamp(intensity, 1, 100) / layerCount;
  const safeHeight = Math.max(height, 1);
  const resolvedFadeStart = clamp(fadeStart, 0, safeHeight);
  const fadeDistance = Math.max(safeHeight - resolvedFadeStart, 0);
  const fadeEnd = Math.max(
    resolvedFadeStart,
    safeHeight - Math.min(2, fadeDistance * 0.08),
  );
  const resolvedBlurMethod =
    blurMethod ?? (blurTarget ? 'dimezisBlurViewSdk31Plus' : undefined);
  const overlayStart = resolvedFadeStart / safeHeight;
  const overlayLocations =
    resolvedEdge === 'top'
      ? ([0, overlayStart, 1] as const)
      : ([0, 1 - overlayStart, 1] as const);
  const overlayGradient =
    resolvedEdge === 'top'
      ? overlayColors
      : overlayColors
        ? ([overlayColors[2], overlayColors[1], overlayColors[0]] as const)
        : null;

  return (
    <View
      pointerEvents="none"
      style={[styles.progressiveBlur, { height }, style]}>
      {fadeDistance === 0 ? (
        <BlurView
          blurMethod={resolvedBlurMethod}
          blurTarget={blurTarget}
          intensity={clamp(intensity, 1, 100)}
          tint={tint}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        Array.from({ length: layerCount }, (_, index) => {
          const bandStart =
            resolvedFadeStart +
            (fadeEnd - resolvedFadeStart) *
              (index / layerCount) *
              0.55;
          const softEnd =
            bandStart + (fadeEnd - bandStart) * 0.72;
          const maskLocations =
            resolvedEdge === 'top'
              ? ([
                  0,
                  bandStart / safeHeight,
                  softEnd / safeHeight,
                  fadeEnd / safeHeight,
                  1,
                ] as const)
              : ([
                  0,
                  1 - fadeEnd / safeHeight,
                  1 - softEnd / safeHeight,
                  1 - bandStart / safeHeight,
                  1,
                ] as const);
          const maskColors =
            resolvedEdge === 'top'
              ? ([
                  '#000000',
                  '#000000',
                  'rgba(0, 0, 0, 0.18)',
                  'transparent',
                  'transparent',
                ] as const)
              : ([
                  'transparent',
                  'transparent',
                  'rgba(0, 0, 0, 0.18)',
                  '#000000',
                  '#000000',
                ] as const);

          return (
            <MaskedView
              key={index}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
              maskElement={
                <LinearGradient
                  colors={maskColors}
                  locations={maskLocations}
                  style={StyleSheet.absoluteFill}
                />
              }>
              <BlurView
                blurMethod={resolvedBlurMethod}
                blurTarget={blurTarget}
                intensity={layerIntensity}
                tint={tint}
                style={StyleSheet.absoluteFill}
              />
            </MaskedView>
          );
        })
      )}

      {overlayGradient ? (
        <LinearGradient
          colors={overlayGradient}
          locations={overlayLocations}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  );
}

type ProgressiveBlurBarProps = Omit<
  ProgressiveBlurProps,
  'height' | 'fadeStart' | 'edge' | 'direction' | 'style'
> & {
  children?: ReactNode;
  /**
   * Height of the visible header or footer content, excluding the safe area.
   */
  barHeight?: number;
  /**
   * How far the blur extends beyond the visible bar. Defaults to 16 points.
   */
  spill?: number;
  /**
   * Length of the blur transition. It begins behind the bar when falloff is
   * larger than spill. Defaults to 64 points.
   */
  falloff?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  zIndex?: number;
};

export type ProgressiveBlurHeaderProps = ProgressiveBlurBarProps & {
  /**
   * Legacy alias for barHeight.
   * @deprecated Use barHeight.
   */
  headerHeight?: number;
  /**
   * Legacy alias that sets both spill and falloff.
   * @deprecated Use spill and falloff separately.
   */
  fadeDistance?: number;
  /**
   * Optional scroll value. When provided, the blur is transparent at rest and
   * fades in during the first revealDistance points of scrolling.
   */
  scrollY?: SharedValue<number>;
  revealDistance?: number;
};

/**
 * Safe-area-aware progressive header. Render it after the ScrollView so the
 * native blur can sample dynamic content.
 */
export function ProgressiveBlurHeader({
  headerHeight,
  fadeDistance,
  scrollY,
  revealDistance = DEFAULT_REVEAL_DISTANCE,
  barHeight = headerHeight,
  spill = fadeDistance,
  falloff = fadeDistance,
  ...props
}: ProgressiveBlurHeaderProps) {
  return (
    <ProgressiveBlurBar
      {...props}
      edge="top"
      barHeight={barHeight}
      spill={spill}
      falloff={falloff}
      scrollY={scrollY}
      revealDistance={revealDistance}
    />
  );
}

export type ProgressiveBlurFooterProps = ProgressiveBlurBarProps & {
  /**
   * Positions a floating bar like the Revolut tab bar slightly inside the
   * bottom safe area instead of directly above it.
   */
  floating?: boolean;
};

/**
 * Safe-area-aware progressive footer or tab-bar backdrop.
 */
export function ProgressiveBlurFooter({
  floating = false,
  ...props
}: ProgressiveBlurFooterProps) {
  return (
    <ProgressiveBlurBar
      {...props}
      edge="bottom"
      floating={floating}
    />
  );
}

type InternalProgressiveBlurBarProps = ProgressiveBlurBarProps & {
  edge: ProgressiveBlurEdge;
  floating?: boolean;
  scrollY?: SharedValue<number>;
  revealDistance?: number;
};

function ProgressiveBlurBar({
  children,
  edge,
  floating = false,
  scrollY,
  revealDistance = DEFAULT_REVEAL_DISTANCE,
  barHeight = DEFAULT_BAR_HEIGHT,
  spill = DEFAULT_SPILL,
  falloff = DEFAULT_FALLOFF,
  contentStyle,
  style,
  zIndex = 10,
  ...blurProps
}: InternalProgressiveBlurBarProps) {
  const insets = useSafeAreaInsets();
  const safeInset = edge === 'top' ? insets.top : insets.bottom;
  const edgeOffset =
    edge === 'bottom' && floating
      ? Math.max(safeInset - 16, 12)
      : safeInset;
  const contentHeight =
    edge === 'bottom' && floating
      ? barHeight
      : barHeight + safeInset;
  const backdropHeight = barHeight + edgeOffset + Math.max(spill, 0);
  const fadeStart = backdropHeight - Math.max(falloff, 0);
  const safeRevealDistance = Math.max(revealDistance, 1);
  const blurStyle = useAnimatedStyle(() => ({
    opacity: scrollY
      ? interpolate(
          scrollY.value,
          [0, safeRevealDistance],
          [0, 1],
          Extrapolation.CLAMP,
        )
      : 1,
  }));
  const isTop = edge === 'top';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.edgeBar,
        isTop ? { top: 0 } : { bottom: 0 },
        {
          height: backdropHeight,
          zIndex,
        },
        style,
      ]}>
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, blurStyle]}>
        <ProgressiveBlur
          {...blurProps}
          edge={edge}
          height={backdropHeight}
          fadeStart={fadeStart}
          style={isTop ? { top: 0 } : { bottom: 0 }}
        />
      </Animated.View>

      <View
        pointerEvents="box-none"
        style={[
          styles.barContent,
          isTop
            ? {
                top: 0,
                height: contentHeight,
                paddingTop: safeInset,
              }
            : {
                bottom: edge === 'bottom' && floating ? edgeOffset : 0,
                height: contentHeight,
                paddingBottom: edge === 'bottom' && floating ? 0 : safeInset,
              },
          contentStyle,
        ]}>
        {children}
      </View>
    </View>
  );
}

/**
 * Creates a Reanimated scroll value and handler for ProgressiveBlurHeader.
 */
export function useProgressiveBlurScroll() {
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollY.value = Math.max(event.contentOffset.y, 0);
    },
  });

  return { scrollY, onScroll };
}

/**
 * Content inset occupied by a visible bar. The blur spill and falloff are
 * intentionally excluded because scrolling content should pass underneath.
 */
export function useProgressiveBlurInset(
  edge: ProgressiveBlurEdge,
  barHeight = DEFAULT_BAR_HEIGHT,
  floating = false,
) {
  const insets = useSafeAreaInsets();

  if (edge === 'top') {
    return insets.top + barHeight;
  }

  const bottomOffset = floating
    ? Math.max(insets.bottom - 16, 12)
    : insets.bottom;
  return bottomOffset + barHeight;
}

/**
 * Backwards-compatible top inset helper.
 */
export function useProgressiveBlurHeaderHeight(
  headerHeight = DEFAULT_BAR_HEIGHT,
  extraInset = 0,
) {
  return useProgressiveBlurInset('top', headerHeight) + extraInset;
}

export function useProgressiveBlurFooterHeight(
  footerHeight = DEFAULT_BAR_HEIGHT,
  floating = false,
) {
  return useProgressiveBlurInset('bottom', footerHeight, floating);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

const styles = StyleSheet.create({
  progressiveBlur: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  edgeBar: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  barContent: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
});
