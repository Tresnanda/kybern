// FILE: marquee.ts
// Purpose: Measure how far a truncated label must pan to show its tail and hand
//          the numbers to the CSS hover marquee (styles/motion.css `.t-marquee`).
// Layer: UI motion helper
// Exports: primeMarquee

/** Pixels per second the label travels; constant so long titles take longer, not faster. */
const MARQUEE_SPEED = 28;
const MARQUEE_MIN_MS = 900;

/**
 * Call from the host row's pointerenter (and focus) handler. Finds every
 * `.t-marquee` label inside `host`, measures the hidden overflow of its text,
 * and writes `--marquee-shift` / `--marquee-dur` so the CSS transition pans at
 * a steady speed. Labels that fit get a zero shift and stay put.
 */
export function primeMarquee(host: HTMLElement) {
  measure(host);
  // Rows widen their trailing padding on hover (the action cluster slides in),
  // which narrows the label. Measure again once that settles, still inside the
  // pan's start delay, so the shift accounts for the final slot width.
  window.setTimeout(() => {
    if (host.matches(":hover, :focus-within")) measure(host);
  }, 180);
}

function measure(host: HTMLElement) {
  for (const label of host.querySelectorAll<HTMLElement>(".t-marquee")) {
    // The shown text is the last child (a swap may keep the leaving copy first).
    const text = label.lastElementChild as HTMLElement | null;
    if (!text) continue;
    const overflow = Math.max(0, text.scrollWidth - label.clientWidth);
    label.style.setProperty("--marquee-shift", `${-overflow}px`);
    label.style.setProperty(
      "--marquee-dur",
      `${Math.max(MARQUEE_MIN_MS, Math.round((overflow / MARQUEE_SPEED) * 1000))}ms`,
    );
  }
}
