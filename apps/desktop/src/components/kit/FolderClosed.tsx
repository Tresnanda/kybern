// FILE: FolderClosed.tsx
// Purpose: Shared folder glyphs (closed/open) used by the sidebar, command
//          palette, picker, and composer.
// Layer: Web UI primitive
// Exports: FolderClosed, FolderOpen

import type { SVGProps } from "react";
import { Folder01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { hugeGlyph } from "@/lib/kit/hugeGlyph";

// Folders use a lighter stroke than the shared 2.5 (large, dense glyph).
const ClosedGlyph = hugeGlyph(Folder01Icon, 2);
const OpenGlyph = hugeGlyph(FolderOpenIcon, 2);

export function FolderClosed(props: SVGProps<SVGSVGElement>) {
  return <ClosedGlyph {...props} />;
}

export function FolderOpen(props: SVGProps<SVGSVGElement>) {
  return <OpenGlyph {...props} />;
}
