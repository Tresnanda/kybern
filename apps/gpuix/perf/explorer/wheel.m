// Synthetic precise AppKit events enter GPUIView's real scrollWheel: handler.
// No Accessibility grant, cursor movement, automation RPC or CGEvent posting.
#import <AppKit/AppKit.h>
#import <stdatomic.h>
#import <mach/mach_time.h>
@interface ExplorerWheelEvent : NSEvent
@property NSPoint point;
@property CGFloat dx;
@property CGFloat dy;
@property NSEventPhase contact;
@property NSEventPhase momentum;
@property NSTimeInterval offeredAt;
@end
@interface ExplorerWheelPlayer : NSObject {
@public _Atomic int delivered;
}
@property NSView *view;
@property double *latencies;
@end
@implementation ExplorerWheelPlayer
- (void)deliver:(ExplorerWheelEvent *)event {
    [self.view scrollWheel:event];
    int index = atomic_load(&delivered);
    self.latencies[index] = (NSProcessInfo.processInfo.systemUptime - event.offeredAt) * 1000;
    atomic_fetch_add(&delivered, 1);
}
- (void)dealloc { free(self.latencies); }
@end
@implementation ExplorerWheelEvent
- (NSEventType)type { return NSEventTypeScrollWheel; }
- (NSPoint)locationInWindow { return self.point; }
- (NSEventModifierFlags)modifierFlags { return 0; }
- (NSTimeInterval)timestamp { return NSProcessInfo.processInfo.systemUptime; }
- (BOOL)hasPreciseScrollingDeltas { return YES; }
- (CGFloat)scrollingDeltaX { return self.dx; }
- (CGFloat)scrollingDeltaY { return self.dy; }
- (CGFloat)deltaX { return self.dx; }
- (CGFloat)deltaY { return self.dy; }
- (NSEventPhase)phase { return self.contact; }
- (NSEventPhase)momentumPhase { return self.momentum; }
- (BOOL)isDirectionInvertedFromDevice { return NO; }
@end
static NSView *findGPUI(NSView *view) {
    if ([NSStringFromClass(view.class) containsString:@"GPUI"]) return view;
    for (NSView *child in view.subviews) { NSView *found = findGPUI(child); if (found) return found; }
    return nil;
}
void explorerFloat(void) {
    for (NSWindow *window in NSApplication.sharedApplication.windows) {
        window.level = NSFloatingWindowLevel;
        window.ignoresMouseEvents = YES;
        [window orderFrontRegardless];
    }
}
void explorerStartWheel(double x, double y, int count, double magnitude, int horizontal, const char *donePath) {
    ExplorerWheelPlayer *player = [ExplorerWheelPlayer new];
    NSWindow *window = NSApplication.sharedApplication.windows.firstObject;
    player.view = findGPUI(window.contentView);
    player.latencies = calloc(count, sizeof(double));
    const double height = window.contentView.bounds.size.height;
    NSString *done = [NSString stringWithUTF8String:donePath];
    atomic_store(&player->delivered, 0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        mach_timebase_info_data_t timebase; mach_timebase_info(&timebase);
        uint64_t start = mach_absolute_time();
        NSMutableArray *times = [NSMutableArray arrayWithCapacity:count];
        for (int i = 0; i < count; i++) { @autoreleasepool {
            int phase = i % 300;
            double delta = (i % 600 < 300 ? -1 : 1) * magnitude * (phase < 120 ? sin(M_PI * MIN(phase + 1, 30) / 60) : exp(-(phase - 120) / 45.0));
            ExplorerWheelEvent *event = [ExplorerWheelEvent new];
            event.point = NSMakePoint(x, height - y);
            event.dx = horizontal ? delta : 0; event.dy = horizontal ? 0 : delta;
            event.contact = phase == 0 ? NSEventPhaseBegan : phase == 119 ? NSEventPhaseEnded : phase < 119 ? NSEventPhaseChanged : 0;
            event.momentum = phase == 120 ? NSEventPhaseBegan : phase == 299 ? NSEventPhaseEnded : phase > 120 ? NSEventPhaseChanged : 0;
            event.offeredAt = NSProcessInfo.processInfo.systemUptime;
            [times addObject:@((mach_absolute_time() - start) * (double)timebase.numer / timebase.denom / 1e6)];
            [player performSelectorOnMainThread:@selector(deliver:) withObject:event waitUntilDone:NO];
            mach_wait_until(start + (uint64_t)((i + 1) * (1e9 / 120) * timebase.denom / timebase.numer));
        } }
        int applied = atomic_load(&player->delivered);
        NSMutableArray *latencies = [NSMutableArray arrayWithCapacity:applied];
        for (int i = 0; i < applied; i++) [latencies addObject:@(player.latencies[i])];
        NSDictionary *result = @{ @"offered": times, @"deliveredAtOfferEnd": @(applied), @"handlerLatencies": latencies, @"durationMs": @((mach_absolute_time() - start) * (double)timebase.numer / timebase.denom / 1e6) };
        [[NSJSONSerialization dataWithJSONObject:result options:0 error:nil] writeToFile:done atomically:YES];
    });
}
