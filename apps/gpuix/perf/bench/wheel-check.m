// No window, daemon or automation clock: verify the NSEvent GPUI actually reads.
#import "wheel.m"
#include <assert.h>
#include <math.h>
int main(void) {
 @autoreleasepool {
  const double deltas[] = {-6, -2.94, -.705894, -.118637, -.001, 0, .001, .118637, .705894, 2.94, 6};
  for (int i=0;i<sizeof(deltas)/sizeof(deltas[0]);i++) {
   for (int momentum=0;momentum<2;momentum++) {
    NSEvent *event=benchEvent(deltas[i],momentum?0:2,momentum?2:0);
    assert(event.type==NSEventTypeScrollWheel);
    assert(event.hasPreciseScrollingDeltas);
    assert(fabs(event.scrollingDeltaY-deltas[i])<1e-9);
    assert(event.phase==(momentum?0:NSEventPhaseChanged));
    assert(event.momentumPhase==(momentum?NSEventPhaseChanged:0));
    printf("%.6f -> %.6f contact=%lu momentum=%lu\n",deltas[i],event.scrollingDeltaY,(unsigned long)event.phase,(unsigned long)event.momentumPhase);
   }
  }
 }
 return 0;
}
