// The in-app text size: a per-device multiplier over the type scale, applied
// on top of the system font scale (Dynamic Type / Android font size). Pure, so
// tests can import it without React Native.

/** The Settings → Appearance steps. 1 is the default and draws the type scale unchanged. */
export const TEXT_SCALES = [0.85, 0.92, 1, 1.1, 1.2, 1.35] as const;
export type TextScale = (typeof TEXT_SCALES)[number];
export const DEFAULT_TEXT_SCALE: TextScale = 1;

export const textScaleLabel = (scale: number) => `${Math.round(scale * 100)}%`;

/** A stored value back to a step; anything unknown is the default. */
export function parseTextScale(value: string | null | undefined): TextScale {
  const n = Number(value);
  return TEXT_SCALES.find((step) => step === n) ?? DEFAULT_TEXT_SCALE;
}

/**
 * One size at a scale. Font sizes keep a tenth of a point; line heights round
 * to whole points so stacked lines stay on the pixel grid.
 */
export const scaleFont = (size: number, scale: number) =>
  scale === 1 ? size : Math.round(size * scale * 10) / 10;
export const scaleLine = (height: number, scale: number) =>
  scale === 1 ? height : Math.round(height * scale);

type Metrics = { fontSize?: number; lineHeight?: number };

/** A style with its font size and line height scaled; the same object at 1 or when it sets neither. */
export function scaleMetrics<S extends Metrics>(style: S, scale: number): S {
  if (scale === 1 || (style.fontSize === undefined && style.lineHeight === undefined)) return style;
  return {
    ...style,
    ...(style.fontSize !== undefined ? { fontSize: scaleFont(style.fontSize, scale) } : null),
    ...(style.lineHeight !== undefined ? { lineHeight: scaleLine(style.lineHeight, scale) } : null),
  };
}

const tables = new WeakMap<object, Map<number, object>>();
/**
 * Every role of a type table at one scale, built once per (table, scale) and
 * then shared, so rows re-render against the same objects. At 1 it is the
 * table itself.
 */
export function scaleTypeTable<Table extends Record<string, Metrics>>(table: Table, scale: number): Table {
  if (scale === 1) return table;
  let byScale = tables.get(table);
  if (!byScale) tables.set(table, (byScale = new Map()));
  const cached = byScale.get(scale);
  if (cached) return cached as Table;
  const scaled = Object.fromEntries(
    Object.entries(table).map(([role, style]) => [role, Object.freeze(scaleMetrics(style, scale))]),
  ) as Table;
  byScale.set(scale, scaled);
  return scaled;
}
