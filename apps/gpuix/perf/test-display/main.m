// Hidden test display for GPUIX automation: a 1440x900 @2x (Retina) 60 Hz
// virtual display that exists only while this process runs. Automated windows
// open there (see automation_display.rs / shell/window.ts), fully composited,
// away from the user's screen. Writes its display id to
// /tmp/kybern-gpuix-test-display and removes it on exit (SIGINT/SIGTERM).
// Uses the private CGVirtualDisplay API (as DeskPad/BetterDisplay do).
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <signal.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property(retain, nonatomic) dispatch_queue_t queue;
@property(retain, nonatomic) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide;
@property(nonatomic) unsigned int maxPixelsHigh;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) unsigned int productID;
@property(nonatomic) unsigned int vendorID;
@property(nonatomic) unsigned int serialNum;
@property(copy, nonatomic) void (^terminationHandler)(id, id);
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic) unsigned int hiDPI;
@property(retain, nonatomic) NSArray *modes;
@end
@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(readonly, nonatomic) CGDirectDisplayID displayID;
@end

static const char *MARKER = "/tmp/kybern-gpuix-test-display";
static void stop(int sig) { unlink(MARKER); _exit(0); }

int main(void) {
  @autoreleasepool {
    signal(SIGINT, stop); signal(SIGTERM, stop); signal(SIGHUP, stop);
    CGVirtualDisplayDescriptor *d = [CGVirtualDisplayDescriptor new];
    d.queue = dispatch_get_main_queue();
    d.name = @"Kybern test display";
    d.maxPixelsWide = 2880; d.maxPixelsHigh = 1800;
    d.sizeInMillimeters = CGSizeMake(302, 189);
    d.productID = 0x4b59; d.vendorID = 0x4b42; d.serialNum = 0x0001;
    d.terminationHandler = ^(id a, id b) { unlink(MARKER); exit(0); };
    CGVirtualDisplay *display = [[CGVirtualDisplay alloc] initWithDescriptor:d];
    if (!display || !display.displayID) { fprintf(stderr, "could not create virtual display\n"); return 1; }
    CGVirtualDisplaySettings *s = [CGVirtualDisplaySettings new];
    s.hiDPI = 1;
    s.modes = @[[[CGVirtualDisplayMode alloc] initWithWidth:1440 height:900 refreshRate:60]];
    if (![display applySettings:s]) { fprintf(stderr, "could not apply settings\n"); return 1; }
    CGDirectDisplayID vid = display.displayID;
    // Park it diagonally off the built-in screen's bottom-left corner so the
    // pointer only reaches it through a single corner point.
    CGDisplayConfigRef config;
    if (CGBeginDisplayConfiguration(&config) == kCGErrorSuccess) {
      CGRect main = CGDisplayBounds(CGMainDisplayID());
      CGConfigureDisplayOrigin(config, vid, (int32_t)(main.origin.x - 1440), (int32_t)(main.origin.y + main.size.height));
      CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
    }
    FILE *f = fopen(MARKER, "w"); fprintf(f, "%u\n", vid); fclose(f);
    printf("test display %u ready\n", vid); fflush(stdout);
    dispatch_main();
  }
}
