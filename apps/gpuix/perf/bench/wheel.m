// Timing-only AppKit injector: private to this process/window; no global events.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
static NSWindow *benchWindow;
static NSPoint benchPoint;
static NSWindow *eventWindow(id self, SEL cmd) { return benchWindow; }
static NSInteger eventWindowNumber(id self, SEL cmd) { return benchWindow.windowNumber; }
static NSPoint eventLocation(id self, SEL cmd) { return benchPoint; }
// NSEvent created by CoreGraphics carries real precise/phase fields. Dispatch
// directly to the GPUI content view after converting the global cursor position.
int bench_scroll(double x, double y, double delta, int phase, int momentum) {
 @autoreleasepool {
  NSWindow *window = NSApp.windows.firstObject;
  if (!window) return 0;
  NSView *view = window.contentView;
  NSPoint local = NSMakePoint(x, view.bounds.size.height-y);
  NSPoint screen = [window convertPointToScreen:[view convertPoint:local toView:nil]];
  NSScreen *main = NSScreen.screens.firstObject;
  CGEventRef cg = CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,(int32_t)delta);
  CGEventSetLocation(cg,CGPointMake(screen.x,main.frame.size.height-screen.y));
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventFixedPtDeltaAxis1,delta);
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventPointDeltaAxis1,delta);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventIsContinuous,1);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventScrollPhase,phase);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventMomentumPhase,momentum);
  CGEventSetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointer,window.windowNumber);
  CGEventSetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,window.windowNumber);
  NSEvent *event = [NSEvent eventWithCGEvent:cg];
  CFRelease(cg);
  if (!event) return 0;
  // A process-local CGEvent has no WindowServer association. Preserve the real
  // concrete NSEvent implementation and supply only this harness's target.
  Class concrete = object_getClass(event);
  NSString *name = [@"Bench_" stringByAppendingString:NSStringFromClass(concrete)];
  Class targeted = NSClassFromString(name);
  if (!targeted) {
   targeted = objc_allocateClassPair(concrete,name.UTF8String,0);
   class_addMethod(targeted,@selector(window),(IMP)eventWindow,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(window))));
   class_addMethod(targeted,@selector(windowNumber),(IMP)eventWindowNumber,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(windowNumber))));
   class_addMethod(targeted,@selector(locationInWindow),(IMP)eventLocation,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(locationInWindow))));
   objc_registerClassPair(targeted);
  }
  benchWindow = window; benchPoint = [view convertPoint:local toView:nil];
  object_setClass(event,targeted);
  [window sendEvent:event];
  return 1;
 }
}
