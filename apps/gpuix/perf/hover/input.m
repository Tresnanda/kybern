// Fixture-only AppKit events to the owning process's GPUIView, without focus
// changes or global event posting. Unlike automation.click, clickCount is real.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
static NSView *gpuiview(NSView *view) {
 if ([NSStringFromClass(view.class) containsString:@"GPUI"]) return view;
 for(NSView *child in view.subviews){NSView *found=gpuiview(child);if(found)return found;}
 return nil;
}
// The controller first verifies that this owned window is on the hidden test
// display. Keep it above background windows without making it key/active;
// WindowServer must capture full-size content rather than an occluded preview.
int hr5_prepare(void) {
 NSWindow *window=NSApp.windows.firstObject;
 if(!window||!gpuiview(window.contentView))return 0;
 [window setLevel:NSFloatingWindowLevel];
 [window setCollectionBehavior:NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle|NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorCanJoinAllApplications|NSWindowCollectionBehaviorFullScreenAuxiliary];
 [window setAnimationBehavior:NSWindowAnimationBehaviorNone];
 [window setHidesOnDeactivate:NO];
 [window setCanHide:NO];
 [window orderFrontRegardless];
 return 1;
}
int hr5_click(double x,double y,int count) {
 @autoreleasepool {
  NSWindow *window=NSApp.windows.firstObject;
  if(!window)return 0;
  NSView *view=window.contentView,*target=gpuiview(view);
  if(!target)return 0;
  NSPoint point=[view convertPoint:NSMakePoint(x,view.bounds.size.height-y) toView:nil];
  for(int click=1;click<=count;click++)for(NSNumber *type in @[@(NSEventTypeLeftMouseDown),@(NSEventTypeLeftMouseUp)]){
   NSEvent *event=[NSEvent mouseEventWithType:type.unsignedIntegerValue location:point modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:click clickCount:click pressure:1];
   if(type.unsignedIntegerValue==NSEventTypeLeftMouseDown)[target mouseDown:event];else [target mouseUp:event];
  }
  return 1;
 }
}

// GPUI asks NSWindow for the cursor on resize. The controlling automation
// mouse is process-local; the real OS cursor belongs to the person on the
// MacBook. Supply the parked automation point on this owned test window only.
static NSPoint parkedMouse;
static NSPoint virtualMouse(id window,SEL selector){return parkedMouse;}
int hr5_resize(double width,double height,double x,double y) {
 NSWindow *window=NSApp.windows.firstObject;
 if(!window)return 0;
 NSView *view=window.contentView;
 parkedMouse=[view convertPoint:NSMakePoint(x,view.bounds.size.height-y) toView:nil];
 Class original=object_getClass(window);
 Method method=class_getInstanceMethod(original,@selector(mouseLocationOutsideOfEventStream));
 class_replaceMethod(original,@selector(mouseLocationOutsideOfEventStream),(IMP)virtualMouse,method_getTypeEncoding(method));
 NSRect frame=window.frame;
 NSPoint topLeft=NSMakePoint(NSMinX(frame),NSMaxY(frame));
 [window setContentSize:NSMakeSize(width,height)];
 [window setFrameTopLeftPoint:topLeft];
 return 1;
}
