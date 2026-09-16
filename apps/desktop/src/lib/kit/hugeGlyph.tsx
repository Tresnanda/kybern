// FILE: hugeGlyph.tsx
// Purpose: Cheap, precomputed renderer for Hugeicons glyphs.
//
// @hugeicons/react's <HugeiconsIcon> re-sorts the icon's paths and re-creates a
// React element for each one on EVERY render. In a transcript full of icons that
// per-render work regressed scroll frame times badly (p95 25ms -> 54ms on CI).
// Icons are static, so we build their path children ONCE per glyph and reuse the
// same elements across every render — the visual output matches HugeiconsIcon for
// the single-colour free set (no two-tone/opacity paths to sort).

import { createElement, type ReactNode, type SVGProps } from "react";
import type { IconSvgElement } from "@hugeicons/react";

export type Glyph = (props: SVGProps<SVGSVGElement>) => ReactNode;

const SVG_PROPS = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
} as const;

function glyphChildren(icon: IconSvgElement, paint: { stroke?: number; fill?: boolean }): ReactNode[] {
  return icon.map(([tag, attrs], index) => {
    // Spread the glyph's own attrs, then override its string `key` with our index.
    const props: Record<string, unknown> = { ...(attrs as Record<string, unknown>), key: index };
    if (paint.fill) {
      props.fill = "currentColor";
    }
    if (paint.stroke != null) {
      props.stroke = "currentColor";
      props.strokeWidth = paint.stroke;
    }
    return createElement(tag, props);
  });
}

/** Stroke glyph at the given width; children precomputed once. */
export function hugeGlyph(icon: IconSvgElement, strokeWidth: number): Glyph {
  const children = glyphChildren(icon, { stroke: strokeWidth });
  return (props) => createElement("svg", { ...SVG_PROPS, ...props }, children);
}

/** Solid glyph: fill the paths with currentColor (keeps any stroke-only detail). */
export function hugeGlyphFilled(icon: IconSvgElement): Glyph {
  const children = glyphChildren(icon, { fill: true });
  return (props) => createElement("svg", { ...SVG_PROPS, ...props }, children);
}
