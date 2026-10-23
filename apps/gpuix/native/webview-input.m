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
