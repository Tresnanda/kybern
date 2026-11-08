// Test-only in-process AppKit pointer events for zoom-check.ts (#292). Like caps-lock-input.m, nothing is posted
// globally: each event goes to the lab window's own sendEvent:, the way AppKit delivers a real press, so it enters GPUI
// through its macOS platform path (platform_input_from_native → on_input) and is converted from OS points to content
// pixels there. Positions are window points from the top-left of the content view.
#import <Cocoa/Cocoa.h>

static NSWindow *lab_window(const char *title) {
  NSString *name = [NSString stringWithUTF8String:title];
  for (NSWindow *window in NSApp.windows) if ([window.title isEqual:name]) return window;
  return nil;
}

static NSPoint in_window(NSWindow *window, double x, double y) {
  return NSMakePoint(x, window.contentView.bounds.size.height - y);
}

enum { MOVE = 0, DOWN = 1, UP = 2, DRAG = 3 };

static void send_mouse(NSWindow *window, int kind, double x, double y, int clicks) {
  NSEventType type = kind == DOWN ? NSEventTypeLeftMouseDown : kind == UP ? NSEventTypeLeftMouseUp : kind == DRAG ? NSEventTypeLeftMouseDragged : NSEventTypeMouseMoved;
  NSEvent *event = [NSEvent mouseEventWithType:type location:in_window(window, x, y) modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
                                  windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:clicks pressure:kind == DOWN || kind == DRAG ? 1 : 0];
  [window sendEvent:event];
}

/** One pointer event at window point (x, y), on the next main-queue turn. */
void kybern_zoom_mouse(const char *title, int kind, double x, double y, int clicks) {
  NSString *name = [NSString stringWithUTF8String:title];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = lab_window(name.UTF8String);
    if (window) send_mouse(window, kind, x, y, clicks);
  });
}

/** A press at (x0, y0), `steps` drags to (x1, y1) and the release there, one event per main-queue turn. */
void kybern_zoom_drag(const char *title, double x0, double y0, double x1, double y1, int steps) {
  NSString *name = [NSString stringWithUTF8String:title];
  for (int i = 0; i <= steps + 1; i++) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)i * 16 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      NSWindow *window = lab_window(name.UTF8String);
      if (!window) return;
      if (i == 0) { send_mouse(window, DOWN, x0, y0, 1); return; }
      double f = MIN(1.0, (double)i / steps);
      send_mouse(window, i == steps + 1 ? UP : DRAG, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, 1);
    });
  }
}

/** A trackpad-style scroll of `dy` points (pixel delta, positive scrolls the content up) at window point (x, y). */
void kybern_zoom_scroll(const char *title, double x, double y, double dy) {
  NSString *name = [NSString stringWithUTF8String:title];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = lab_window(name.UTF8String);
    if (!window) return;
    // An NSEvent made from a CGEvent belongs to no window, so its `locationInWindow` is the CG location in screen
    // points (bottom-left origin): put the window point there.
    NSPoint at = in_window(window, x, y);
    CGFloat top = NSScreen.screens.firstObject.frame.size.height;
    CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 1, (int32_t)-dy);
    CGEventSetLocation(cg, CGPointMake(at.x, top - at.y));
    // A trackpad's precise pixel delta (`hasPreciseScrollingDeltas`), the delta GPUI divides by the zoom.
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, 1);
    NSEvent *event = [NSEvent eventWithCGEvent:cg];
    CFRelease(cg);
    // Straight to the view under the point: the window would route a scroll by the real pointer's position.
    NSView *view = [window.contentView hitTest:[window.contentView convertPoint:event.locationInWindow fromView:nil]] ?: window.contentView;
    if (event) [view scrollWheel:event];
  });
}

/** The window's content minimum size and content size, in points: "minW minH width height". */
const char *kybern_zoom_sizes(const char *title) {
  static char out[128];
  __block NSString *text = @"";
  void (^read)(void) = ^{
    NSWindow *window = lab_window(title);
    if (!window) return;
    NSSize min = window.contentMinSize, size = window.contentView.bounds.size;
    text = [NSString stringWithFormat:@"%g %g %g %g", min.width, min.height, size.width, size.height];
  };
  if (NSThread.isMainThread) read(); else dispatch_sync(dispatch_get_main_queue(), read);
  snprintf(out, sizeof out, "%s", text.UTF8String);
  return out;
}

/** Orders the lab window in front without activating the app (no keyboard taken): an embedded web view hides while its
 *  window is covered, and the check captures it. */
void kybern_zoom_front(const char *title) {
  NSString *name = [NSString stringWithUTF8String:title];
  dispatch_async(dispatch_get_main_queue(), ^{ [lab_window(name.UTF8String) orderFrontRegardless]; });
}
