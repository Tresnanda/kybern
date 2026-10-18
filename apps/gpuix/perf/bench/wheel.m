// Timing-only AppKit injector: private to this process/window; no global events.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
static NSWindow *benchWindow;
static NSPoint benchPoint;
// CGEvent's point delta is an integer even when set through the double setter.
// NSEvent reads that integer for precise scrollingDeltaY. Keep the offered
// CGFloat through the same process-local subclass used for window targeting.
static NSWindow *eventWindow(id self, SEL cmd);
static NSInteger eventWindowNumber(id self, SEL cmd);
static NSPoint eventLocation(id self, SEL cmd);
static CGFloat benchDelta;
static CGFloat eventDeltaY(id self, SEL cmd) { return benchDelta; }
static NSEvent *benchEvent(double delta, int phase, int momentum) {
  CGEventRef cg = CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,(int32_t)delta);
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventFixedPtDeltaAxis1,delta);
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventPointDeltaAxis1,delta);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventIsContinuous,1);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventScrollPhase,phase);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventMomentumPhase,momentum);
  NSEvent *event = [NSEvent eventWithCGEvent:cg];
  CFRelease(cg);
  if (!event) return nil;
  Class concrete = object_getClass(event);
  NSString *name = [@"Bench_" stringByAppendingString:NSStringFromClass(concrete)];
  Class targeted = NSClassFromString(name);
  if (!targeted) {
   targeted = objc_allocateClassPair(concrete,name.UTF8String,0);
   class_addMethod(targeted,@selector(window),(IMP)eventWindow,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(window))));
   class_addMethod(targeted,@selector(windowNumber),(IMP)eventWindowNumber,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(windowNumber))));
   class_addMethod(targeted,@selector(locationInWindow),(IMP)eventLocation,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(locationInWindow))));
   if (!getenv("KYBERN_BENCH_INTEGER_WHEEL") || strcmp(getenv("KYBERN_BENCH_INTEGER_WHEEL"),"1")) {
   class_addMethod(targeted,@selector(scrollingDeltaY),(IMP)eventDeltaY,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(scrollingDeltaY))));
   class_addMethod(targeted,@selector(deltaY),(IMP)eventDeltaY,method_getTypeEncoding(class_getInstanceMethod(concrete,@selector(deltaY))));
   }
   objc_registerClassPair(targeted);
  }
  benchDelta = delta;
  object_setClass(event,targeted);
  return event;
}
static NSWindow *eventWindow(id self, SEL cmd) { return benchWindow; }
static NSInteger eventWindowNumber(id self, SEL cmd) { return benchWindow.windowNumber; }
static NSPoint eventLocation(id self, SEL cmd) { return benchPoint; }
// NSEvent created by CoreGraphics carries real precise/phase fields. Dispatch
// directly to our own window. Only targeting and fractional delta are supplied
// by the harness; AppKit still carries contact and momentum phases.
int bench_scroll(double x, double y, double delta, int phase, int momentum) {
 @autoreleasepool {
  NSWindow *window = NSApp.windows.firstObject;
  if (!window) return 0;
  NSView *view = window.contentView;
  NSPoint local = NSMakePoint(x, view.bounds.size.height-y);
  NSEvent *event = benchEvent(delta,phase,momentum);
  if (!event) return 0;
  benchWindow = window; benchPoint = [view convertPoint:local toView:nil];
  [window sendEvent:event];
  return 1;
 }
}
