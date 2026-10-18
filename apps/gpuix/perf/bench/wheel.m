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
static double benchObservedDelta, benchHandlerDelta;
static int benchHandlerCount;
static IMP benchOriginalScroll;
double bench_handler_delta(void) { return benchHandlerDelta; }
int bench_handler_count(void) { return benchHandlerCount; }
static void benchHandleScroll(id self, SEL cmd, NSEvent *event) {
 benchHandlerDelta = event.scrollingDeltaY;
 benchHandlerCount++;
 ((void (*)(id,SEL,NSEvent *))benchOriginalScroll)(self,cmd,event);
}
double bench_last_delta(void) { return benchObservedDelta; }
static CGFloat eventDeltaY(id self, SEL cmd) { return benchDelta; }
static NSEvent *benchEvent(double delta, int phase, int momentum) {
  CGEventRef cg = CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,(int32_t)delta);
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventFixedPtDeltaAxis1,delta);
  CGEventSetDoubleValueField(cg,kCGScrollWheelEventPointDeltaAxis1,delta);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventIsContinuous,1);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventScrollPhase,phase);
  CGEventSetIntegerValueField(cg,kCGScrollWheelEventMomentumPhase,momentum);
  if (benchWindow) {
   NSPoint screen = [benchWindow convertPointToScreen:benchPoint];
   NSScreen *main = NSScreen.screens.firstObject;
   CGEventSetLocation(cg,CGPointMake(screen.x,main.frame.size.height-screen.y));
   CGEventSetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointer,benchWindow.windowNumber);
   CGEventSetIntegerValueField(cg,kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent,benchWindow.windowNumber);
  }
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
// to our own GPUIView handler. NSWindow synthetic routing drops most tail
// packets even with exact getters (239/600 vs 600/600 in the handler probe).
// Only targeting and fractional delta are supplied
// by the harness; AppKit still carries contact and momentum phases.
static NSView *benchGPUIView(NSView *view) {
 if ([NSStringFromClass(view.class) containsString:@"GPUI"]) return view;
 for (NSView *child in view.subviews) { NSView *found=benchGPUIView(child); if(found)return found; }
 return nil;
}
int bench_scroll(double x, double y, double delta, int phase, int momentum) {
 @autoreleasepool {
  NSWindow *window = NSApp.windows.firstObject;
  if (!window) return 0;
  NSView *view = window.contentView;
  NSPoint local = NSMakePoint(x, view.bounds.size.height-y);
  benchWindow = window; benchPoint = [view convertPoint:local toView:nil];
  NSEvent *event = benchEvent(delta,phase,momentum);
  if (!event) return 0;
  NSView *target=benchGPUIView(view);
  if (!target) return 0;
  if (!benchOriginalScroll) {
   Class viewClass=object_getClass(target);
   Method method=class_getInstanceMethod(viewClass,@selector(scrollWheel:));
   benchOriginalScroll=method_getImplementation(method);
   class_replaceMethod(viewClass,@selector(scrollWheel:),(IMP)benchHandleScroll,method_getTypeEncoding(method));
  }
  benchHandlerCount=0;benchHandlerDelta=0;
  benchObservedDelta = event.scrollingDeltaY;
  if (!getenv("KYBERN_BENCH_DIRECT_VIEW") || strcmp(getenv("KYBERN_BENCH_DIRECT_VIEW"),"0")) {
   [target scrollWheel:event];
  } else [window sendEvent:event];
  return 1;
 }
}
