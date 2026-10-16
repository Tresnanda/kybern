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
void kybern_web_test_click(double x, double y) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *window = nil; for (NSWindow *w in NSApp.windows) if ([w.title isEqual:@"Kybern embedded preview lab"]) {window=w;break;}
    if (!window) return;
    NSPoint point = NSMakePoint(x,window.contentView.isFlipped ? y : window.contentView.bounds.size.height-y);
    NSView *target = [window.contentView hitTest:point];
    for (NSNumber *type in @[@(NSEventTypeLeftMouseDown),@(NSEventTypeLeftMouseUp)]) {
      NSEvent *event = [NSEvent mouseEventWithType:type.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:1];
      if (type.unsignedIntegerValue==NSEventTypeLeftMouseDown) [target mouseDown:event]; else [target mouseUp:event];
    }
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
