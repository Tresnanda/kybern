// FILE: ThreadRunningSpinner.tsx
// Purpose: Shared inline running glyph for sidebar thread status slots and the palette.
// Layer: Sidebar UI primitive
// Exports: ThreadRunningSpinner

import { MatrixLoader } from "@/components/kybern/motion";
import { cn } from "@/lib/utils";

// A 4×4 matrix dot loader (orbit pattern, corners hidden) sized to the 12px
// glyph slot. Keep the relaxed 1.6s orbit on the translucent sidebar; the
// shared loader composites opacity instead of repainting each dot's colour.
export function ThreadRunningSpinner({ className }: { className?: string }) {
  return (
    <MatrixLoader
      variant="orbit"
      cycle={1600}
      dot={2}
      gap={2}
      className={cn("text-muted-foreground/70", className)}
    />
  );
}
