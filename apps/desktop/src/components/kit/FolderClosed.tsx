// FILE: FolderClosed.tsx
// Purpose: Shared folder glyphs (closed/open) used by the sidebar, command
//          palette, picker, and composer.
// Layer: Web UI primitive
// Exports: FolderClosed, FolderOpen

import type { SVGProps } from "react";
import { Folder01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

function FolderGlyph(icon: IconSvgElement, props: SVGProps<SVGSVGElement>) {
  return (
    <HugeiconsIcon icon={icon} {...props} color="currentColor" strokeWidth={2} />
  );
}

export function FolderClosed(props: SVGProps<SVGSVGElement>) {
  return FolderGlyph(Folder01Icon, props);
}

export function FolderOpen(props: SVGProps<SVGSVGElement>) {
  return FolderGlyph(FolderOpenIcon, props);
}
