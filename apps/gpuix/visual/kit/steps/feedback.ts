// States of the `feedback` gallery section (`visual/kit/sections/feedback.tsx` ↔ `src/kit/gallery/feedback.tsx`).
import type { KitState } from './index.ts'

/**
 * Loops frozen for a still comparison: the desktop's animations paused (spinners at 0°, the skeleton sweep at 623 ms,
 * when its band is far right of the blocks), the GPUIX `feedback-still` section with its loops held. The Empty
 * entrance has finished (settle > 500 ms) on both.
 */
export async function freezeDesktop(page: any, skeletonMs = 623, spinMs = 0) {
  await page.evaluate(({ skeletonMs, spinMs }: { skeletonMs: number; spinMs: number }) => {
    for (const a of document.getAnimations() as any[]) { a.pause(); a.currentTime = a.animationName === 'skeleton' ? skeletonMs : a.animationName === 'spin' ? spinMs : a.effect.getComputedTiming().endTime }
  }, { skeletonMs, spinMs })
}

export const states: Record<string, KitState> = {
  feedback: { section: 'feedback-still', tauri: (page) => freezeDesktop(page), gpuix: async (app) => { await app.clock.fastForward(1500) }, settle: 900, clip: [0, 0, 1280, 420] },
}
