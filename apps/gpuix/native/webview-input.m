// Test-only in-process AppKit events. No global event posting or user window.
#import <Cocoa/Cocoa.h>
// Return the actual AppKit target, including Kybern's rounded host mask.
bool kybern_web_test_hit_webview(double x, double y) {
  __block bool web = false;
  void (^probe)(void) = ^{
    for (NSWindow *window in NSApp.windows) if ([window.title isEqual:@"Kybern embedded preview lab"]) {
      NSPoint point = NSMakePoint(x, window.contentView.isFlipped ? y : window.contentView.bounds.size.height-y);
      for (NSView *target = [window.contentView hitTest:point]; target; target = target.superview)
        if ([target isKindOfClass:NSClassFromString(@"WKWebView")]) { web = true; break; }
      break;
    }
  };
  if (NSThread.isMainThread) probe(); else dispatch_sync(dispatch_get_main_queue(), probe);
  return web;
}
static NSInteger targetWindow;
// The full app (`scripts/focus-app.fixture.ts`) names its window by number; the lab is found by title.
void kybern_web_test_target(long windowNumber) { targetWindow = windowNumber; }
static NSWindow *labWindow(void) {
  if (targetWindow) return [NSApp windowWithWindowNumber:targetWindow];
  for (NSWindow *w in NSApp.windows) if ([w.title isEqual:@"Kybern embedded preview lab"]) return w;
  return nil;
}
void kybern_web_test_click(double x, double y) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow();
    if (!window) return;
    NSPoint point = NSMakePoint(x,window.contentView.isFlipped ? y : window.contentView.bounds.size.height-y);
    NSView *target = [window.contentView hitTest:point];
    for (NSNumber *type in @[@(NSEventTypeLeftMouseDown),@(NSEventTypeLeftMouseUp)]) {
      NSEvent *event = [NSEvent mouseEventWithType:type.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
      if (type.unsignedIntegerValue==NSEventTypeLeftMouseDown) [target mouseDown:event]; else [target mouseUp:event];
    }
    // A real click makes the clicked view first responder (NSWindow does, before mouseDown; doing it first here swallows
    // the click). WebKit itself only takes first responder when the page focuses a field.
    if (target.acceptsFirstResponder && window.firstResponder != target) [window makeFirstResponder:target];
  });
}
void kybern_web_test_type(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSWindow *window in NSApp.windows) if ([window.title isEqual:@"Kybern embedded preview lab"] && [window.firstResponder conformsToProtocol:@protocol(NSTextInputClient)]) {
      [(id<NSTextInputClient>)window.firstResponder insertText:@"kept text" replacementRange:NSMakeRange(NSNotFound,0)]; break;
    }
  });
}
void kybern_web_test_shortcut(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSWindow *window in NSApp.windows) if ([window.title isEqual:@"Kybern embedded preview lab"]) {
      NSEvent *event = [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:NSEventModifierFlagCommand timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:@"l" charactersIgnoringModifiers:@"l" isARepeat:NO keyCode:37];
      [NSApp sendEvent:event]; break;
    }
  });
}
// 0: GPUI's view holds the keyboard, 1: a WKWebView does, 2: anything else.
int kybern_web_test_responder(void) {
  __block int state = 2;
  void (^probe)(void) = ^{
    NSResponder *responder = labWindow().firstResponder;
    if ([NSStringFromClass(responder.class) isEqual:@"GPUIView"]) { state = 0; return; }
    if (![responder isKindOfClass:NSView.class]) return;
    for (NSView *view = (NSView *)responder; view; view = view.superview) if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) { state = 1; return; }
  };
  if (NSThread.isMainThread) probe(); else dispatch_sync(dispatch_get_main_queue(), probe);
  return state;
}
// A press through NSApp, so local event monitors and NSWindow's first-responder handling run as for a real click.
void kybern_web_test_press(double x, double y) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow(); if (!window) return;
    NSPoint point = NSMakePoint(x, window.contentView.bounds.size.height-y);
    for (NSNumber *type in @[@(NSEventTypeLeftMouseDown),@(NSEventTypeLeftMouseUp)])
      [NSApp sendEvent:[NSEvent mouseEventWithType:type.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1]];
  });
}
// A keystroke to the window's first responder, as AppKit delivers one to the key window.
void kybern_web_test_key(const char *characters, unsigned short keyCode) {
  NSString *chars = [NSString stringWithUTF8String:characters];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow(); if (!window) return;
    for (NSNumber *type in @[@(NSEventTypeKeyDown),@(NSEventTypeKeyUp)])
      [window sendEvent:[NSEvent keyEventWithType:type.unsignedIntegerValue location:NSZeroPoint modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:chars charactersIgnoringModifiers:chars isARepeat:NO keyCode:keyCode]];
  });
}
// Test only: the window-relative point an NSEvent made from a CGEvent reports (CoreGraphics, not in its headers). The
// screen location alone is clamped to the displays and gives no window.
extern void CGEventSetWindowLocation(CGEventRef event, CGPoint point);
// A wheel event through NSApp (local monitors run, then AppKit's own hit test), at window point (x, y) from the top-left.
// `phase` is CGScrollPhase (1 began, 2 changed, 4 ended, 128 may begin; 0 none: a mouse wheel), `momentum`
// CGMomentumScrollPhase (1 begin, 2 continue, 3 end). Deltas are points, positive y revealing what is above.
void kybern_web_test_scroll(double x, double y, double dx, double dy, int phase, int momentum) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow(); if (!window) return;
    NSPoint inWindow = NSMakePoint(x, window.contentView.bounds.size.height - y);
    NSPoint screen = [window convertPointToScreen:inWindow];
    CGFloat top = NSScreen.screens.firstObject.frame.size.height;
    CGEventRef cg = CGEventCreateScrollWheelEvent2(NULL, kCGScrollEventUnitPixel, 2, (int32_t)dy, (int32_t)dx, 0);
    CGEventSetLocation(cg, CGPointMake(screen.x, top - screen.y));
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventIsContinuous, phase || momentum ? 1 : 0);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventScrollPhase, phase);
    CGEventSetIntegerValueField(cg, kCGScrollWheelEventMomentumPhase, momentum);
    CGEventSetIntegerValueField(cg, kCGMouseEventWindowUnderMousePointer, window.windowNumber);
    CGEventSetIntegerValueField(cg, kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent, window.windowNumber);
    // The window NSEvent reads (an undocumented field; the two above are only hints) and the point in it, from the top of
    // the frame (GPUI's content view fills it).
    CGEventSetIntegerValueField(cg, (CGEventField)51, window.windowNumber);
    CGEventSetWindowLocation(cg, CGPointMake(x, y + window.frame.size.height - window.contentView.bounds.size.height));
    NSEvent *event = [NSEvent eventWithCGEvent:cg];
    CFRelease(cg);
    if (event) [NSApp sendEvent:event];
  });
}
// A keystroke with modifiers through NSApp, so the key monitor sees it (`flags` are NSEventModifierFlags).
void kybern_web_test_chord(const char *characters, unsigned short keyCode, unsigned long flags) {
  NSString *chars = [NSString stringWithUTF8String:characters];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow(); if (!window) return;
    for (NSNumber *type in @[@(NSEventTypeKeyDown),@(NSEventTypeKeyUp)])
      [NSApp sendEvent:[NSEvent keyEventWithType:type.unsignedIntegerValue location:NSZeroPoint modifierFlags:flags timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil characters:chars charactersIgnoringModifiers:chars isARepeat:NO keyCode:keyCode]];
  });
}
// A drag on the view under (x, y), called directly as `kybern_web_test_click` does (a background window takes no first
// click through NSApp): down there, `steps` drags to (x2, y2) a frame apart, up there.
void kybern_web_test_drag(double x, double y, double x2, double y2, int steps) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = labWindow(); if (!window) return;
    CGFloat h = window.contentView.bounds.size.height;
    NSView *target = [window.contentView hitTest:NSMakePoint(x, window.contentView.isFlipped ? y : h - y)];
    NSEvent *(^make)(NSEventType, double, double) = ^NSEvent *(NSEventType type, double px, double py) {
      return [NSEvent mouseEventWithType:type location:NSMakePoint(px, h - py) modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:type == NSEventTypeLeftMouseUp ? 0 : 1];
    };
    [target mouseDown:make(NSEventTypeLeftMouseDown, x, y)];
    // One step per display frame, as a hand moves (WebKit coalesces moves that arrive together).
    for (int i = 1; i <= steps + 1; i++) dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)i * 16 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (i <= steps) [target mouseDragged:make(NSEventTypeLeftMouseDragged, x + (x2 - x) * i / steps, y + (y2 - y) * i / steps)];
      else [target mouseUp:make(NSEventTypeLeftMouseUp, x2, y2)];
    });
  });
}
