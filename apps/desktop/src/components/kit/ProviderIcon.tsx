/**
 * ProviderIcon - shared provider glyphs for chat, sidebar, and picker surfaces.
 *
 * Centralizes provider-to-icon mapping so new providers do not need repeated
 * branching across every UI surface.
 */
type ProviderKind = string;
import type { ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils";
import {
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  DevinIcon,
  DroidIcon,
  GrokIcon,
  type Icon,
  OpenAI,
  OpenCodeIcon,
  OmpIcon,
  PiIcon,
} from "./Icons";

export type ProviderIconTone = "default" | "header";

// The bundled OpenCode SVG has a hardcoded dark outer frame, so it's inverted in
// dark mode to stay legible on dark surfaces (the mark is monochrome grayscale).
const OpenCodeProviderIcon = ({ className, ...svgProps }: SVGProps<SVGSVGElement>) => (
  <OpenCodeIcon {...svgProps} className={cn(className, "dark:[filter:invert(1)]")} />
);

export const PROVIDER_ICON_COMPONENT_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  cursor: CursorIcon,
  devin: DevinIcon,
  antigravity: AntigravityIcon,
  grok: GrokIcon,
  droid: DroidIcon,
  opencode: OpenCodeProviderIcon,
  pi: PiIcon,
  omp: OmpIcon,
};

export function providerIconToneClassName(
  provider: ProviderKind | null | undefined,
  tone: ProviderIconTone = "default",
): string {
  if (provider === "opencode") {
    return "text-muted-foreground/70";
  }
  if (provider === "codex") {
    return tone === "header" ? "text-muted-foreground/85" : "text-foreground";
  }
  return "text-foreground";
}

export type ProviderIconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  readonly provider: ProviderKind | null | undefined;
  readonly fallback?: ReactNode;
  readonly tone?: ProviderIconTone;
};

export function ProviderIcon({
  provider,
  fallback: fallbackProp,
  tone: toneProp,
  className,
  "aria-hidden": ariaHiddenProp,
  ...svgProps
}: ProviderIconProps) {
  const fallback = fallbackProp ?? null;
  const tone = toneProp ?? "default";
  const ariaHidden = ariaHiddenProp ?? true;
  if (provider === null || provider === undefined) {
    return fallback;
  }

  const Icon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[provider];
  return (
    <Icon
      aria-hidden={ariaHidden}
      {...svgProps}
      className={cn(providerIconToneClassName(provider, tone), className)}
    />
  );
}

export function ProviderOptionLabel({
  provider,
  label,
  className,
  iconClassName,
}: {
  provider: ProviderKind;
  label: ReactNode;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <ProviderIcon provider={provider} className={cn("size-3.5", iconClassName)} />
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
