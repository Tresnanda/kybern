// FILE: DisclosureRegion.tsx
// Purpose: Controlled expand/collapse region with the shared sidebar-style grid animation.
// Layer: UI primitive
// Exports: DisclosureRegion
// Depends on: disclosureMotion helpers

import { useEffect, useState, type ReactNode } from "react";

import {
  DISCLOSURE_INNER_CLASS,
  DISCLOSURE_TRANSITION_MS,
  DISCLOSURE_CLEANUP_BUFFER_MS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "@/lib/kit/disclosureMotion";

export function DisclosureRegion(props: {
  open: boolean;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const { open, children, className, contentClassName } = props;
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);

  return (
    <div
      className={disclosureShellClassName(open, className)}
      aria-hidden={open ? undefined : true}
      inert={!open}
    >
      <div className={DISCLOSURE_INNER_CLASS}>
        {mounted && <div className={disclosureContentClassName(open, contentClassName)}>{children}</div>}
      </div>
    </div>
  );
}
