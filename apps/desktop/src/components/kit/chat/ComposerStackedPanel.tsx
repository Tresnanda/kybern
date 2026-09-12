// FILE: ComposerStackedPanel.tsx
// Purpose: Shared chrome for panels stacked above the composer input.
// Layer: Chat composer layout primitive
// Exports: ComposerPanelStack, ComposerStackedPanel and the inner-row divider.

import { createContext, useContext, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "@/lib/utils";
import { ComposerStackedHeaderFrame } from "@/components/kit/chat/ComposerColumnFrame";
import { COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME } from "@/components/kit/chat/composerStackedPanelStyles";

export { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "@/components/kit/chat/composerStackedPanelStyles";

const ComposerPanelStackContext = createContext(false);

/** One outline and glass layer for attached panels, regardless of their order.
 *  Close the bottom edge when a blocking question replaces the input. */
export function ComposerPanelStack({ children, closed = false }: { children: ReactNode; closed?: boolean }) {
  return (
    <ComposerPanelStackContext value={true}>
      <ComposerStackedHeaderFrame
        className={cn(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME, "composer-panel-stack")}
        data-closed={closed ? "true" : undefined}
      >
        {children}
      </ComposerStackedHeaderFrame>
    </ComposerPanelStackContext>
  );
}

interface ComposerStackedPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** Removes the top radius so this panel visually merges into the one above it. */
  attachedToPrevious?: boolean;
  /** Lets clicks pass through the side margins to the transcript underneath. */
  passthroughSideMargins?: boolean;
  /** Drops the hairline outline, keeping only the translucent surface (empty-landing tray). */
  borderless?: boolean;
}

/** Single owner for composer-stacked panel frame, border, radius, and surface chrome. */
export function ComposerStackedPanel({
  children,
  className,
  ref,
  attachedToPrevious: attachedToPreviousProp,
  passthroughSideMargins: passthroughSideMarginsProp,
  borderless: borderlessProp,
  ...rest
}: ComposerStackedPanelProps) {
  const inStack = useContext(ComposerPanelStackContext);
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const passthroughSideMargins = passthroughSideMarginsProp ?? false;
  const borderless = borderlessProp ?? false;
  if (inStack) {
    return <div ref={ref} className={cn("composer-panel-section", className)} {...rest}>{children}</div>;
  }
  return (
    <ComposerStackedHeaderFrame
      ref={ref}
      passthroughSideMargins={passthroughSideMargins}
      data-composer-stacked-attached={attachedToPrevious ? "true" : undefined}
      className={cn(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME, borderless && "border-0", className)}
      {...rest}
    >
      {children}
    </ComposerStackedHeaderFrame>
  );
}
