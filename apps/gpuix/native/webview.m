#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>

// This library never creates NSApplication. All AppKit/WebKit operations run on
// GPUI's main queue; Bun receives queued events through a threadsafe wakeup.
static void (*signalJS)(void);
static NSMutableArray<NSString *> *events;
static NSString *lastEvent;
static NSMutableDictionary *hosts;
static NSMutableDictionary<NSNumber *, NSDictionary *> *occlusions;
static id keyMonitor;
static BOOL pointerCaptured;
static void emit(NSDictionary *event) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  if (!data || data.length > 65536) return;
  BOOL wake = NO;
  @synchronized(events) { if (events.count < 512) { wake = !events.count; [events addObject:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]]; } }
  if (wake && signalJS) signalJS();
}
@interface KybernWebClip : NSView
@property NSArray<NSBezierPath *> *blocked;
@end
@implementation KybernWebClip
- (BOOL)isFlipped { return YES; }
- (NSView *)hitTest:(NSPoint)point {
  if (pointerCaptured) return nil;
  NSPoint local = [self convertPoint:point fromView:self.superview];
  for (NSBezierPath *path in self.blocked) if ([path containsPoint:local]) return nil;
  return [super hitTest:point];
}
@end
@interface KybernWebShade : NSView
@end
@implementation KybernWebShade
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end
@interface KybernWebHost : NSObject <WKNavigationDelegate, WKScriptMessageHandler, WKURLSchemeHandler>
@property NSString *identifier;
@property NSString *category;
@property WKWebView *web;
@property KybernWebClip *clip;
@property BOOL placed;
@property NSNumber *generation;
@property NSArray<NSString *> *allowedOrigins;
@property NSInteger layer;
@property NSRect logicalClip;
@property NSView *shade;
@property WKFrameInfo *childFrame;
@property NSURL *wrapperURL;
@property NSString *wrapperHTML;
@property BOOL lastVisible;
@property BOOL hasVisibility;
@end
@implementation KybernWebHost
- (void)webView:(WKWebView *)web startURLSchemeTask:(id<WKURLSchemeTask>)task {
  if (![task.request.URL isEqual:self.wrapperURL]) { [task didFailWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorResourceUnavailable userInfo:nil]]; return; }
  NSData *html = [self.wrapperHTML dataUsingEncoding:NSUTF8StringEncoding];
  [task didReceiveResponse:[[NSURLResponse alloc] initWithURL:self.wrapperURL MIMEType:@"text/html" expectedContentLength:html.length textEncodingName:@"utf-8"]];
  [task didReceiveData:html]; [task didFinish];
}
- (void)webView:(WKWebView *)web stopURLSchemeTask:(id<WKURLSchemeTask>)task {}
- (BOOL)allowsURL:(NSURL *)url {
  NSURLComponents *parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  if (![parts.scheme isEqual:@"http"] && ![parts.scheme isEqual:@"https"]) return NO;
  NSString *host = parts.host; if ([host containsString:@":"] && ![host hasPrefix:@"["]) host = [NSString stringWithFormat:@"[%@]",host];
  BOOL defaultPort = !parts.port || ([parts.scheme isEqual:@"http"] && parts.port.integerValue==80) || ([parts.scheme isEqual:@"https"] && parts.port.integerValue==443);
  NSString *origin = [NSString stringWithFormat:@"%@://%@%@", parts.scheme.lowercaseString, host.lowercaseString, defaultPort ? @"" : [@":" stringByAppendingString:parts.port.stringValue]];
  return !parts.user.length && !parts.password.length && [self.allowedOrigins containsObject:origin];
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if ([message.name isEqual:@"kybernFrame"] && !message.frameInfo.isMainFrame) {
    self.childFrame = message.frameInfo;
    emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"navigation",@"url":message.frameInfo.request.URL.absoluteString ?: @""}); return;
  }
  // The untrusted child has the same handler name but cannot send host events.
  if (!message.frameInfo.isMainFrame || ![message.body isKindOfClass:NSDictionary.class]) return;
  emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"message",@"data":message.body});
}
- (void)webView:(WKWebView *)web decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))done {
  // Only the wrapper may be top-level. Child navigation is additionally
  // constrained by iframe sandbox + daemon CSP. No popups, downloads or schemes.
  NSString *scheme = action.request.URL.scheme.lowercaseString;
  BOOL allowed = [scheme isEqual:@"http"] || [scheme isEqual:@"https"] || [scheme isEqual:@"about"];
  if (allowed && ![scheme isEqual:@"about"]) allowed = [self allowsURL:action.request.URL];
  if (action.targetFrame.isMainFrame) allowed = [action.request.URL isEqual:self.wrapperURL];
  if (!action.targetFrame) allowed = NO;
  if (!allowed) emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"externalNavigation",@"url":action.request.URL.absoluteString ?: @""});
  done(allowed ? WKNavigationActionPolicyAllow : WKNavigationActionPolicyCancel);
}
- (void)webView:(WKWebView *)web decidePolicyForNavigationResponse:(WKNavigationResponse *)response decisionHandler:(void (^)(WKNavigationResponsePolicy))done {
  NSURL *url = response.response.URL;
  BOOL allowed = [url isEqual:self.wrapperURL] || [url.scheme isEqual:@"about"] || (!response.isForMainFrame && [self allowsURL:url]);
  if (!allowed) emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"externalNavigation",@"url":url.absoluteString ?: @""});
  done(allowed ? WKNavigationResponsePolicyAllow : WKNavigationResponsePolicyCancel);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)web { emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"terminated"}); }
- (void)webView:(WKWebView *)web didFinishNavigation:(WKNavigation *)navigation { self.hasVisibility = NO; [self visibility]; emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"loaded"}); }
- (void)webView:(WKWebView *)web didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  if (error.code != NSURLErrorCancelled) emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"failed",@"message":error.localizedDescription});
}
- (void)visibility {
  BOOL visible = self.placed && self.clip.window.isVisible && !self.clip.window.isMiniaturized && (self.clip.window.occlusionState & NSWindowOcclusionStateVisible);
  self.clip.hidden = !visible;
  if (!visible && [self.web.window.firstResponder isKindOfClass:NSView.class] && [(NSView *)self.web.window.firstResponder isDescendantOf:self.web]) [self.web.window makeFirstResponder:self.clip.superview];
  if (self.hasVisibility && self.lastVisible == visible) return;
  self.hasVisibility = YES; self.lastVisible = visible;
  emit(@{@"id":self.identifier,@"generation":self.generation,@"type":@"visibility",@"visible":@(visible)});
  [self.web setAllMediaPlaybackSuspended:!visible completionHandler:^{}];
  NSString *script = [NSString stringWithFormat:@"window.kybernVisible && window.kybernVisible(%@)", visible ? @"true" : @"false"];
  [self.web evaluateJavaScript:script completionHandler:nil];
}
- (void)mask {
  CGPathRef path = CGPathCreateWithRect(NSRectToCGRect(self.clip.bounds), NULL);
  NSMutableArray<NSBezierPath *> *blocked = [NSMutableArray new]; CGFloat dim = 0;
  for (NSNumber *layer in occlusions) {
    NSDictionary *entry = occlusions[layer], *r = entry[@"rect"];
    if ([entry[@"order"] integerValue] <= self.layer) continue;
    NSRect hole = NSMakeRect([r[@"x"] doubleValue] - self.logicalClip.origin.x, [r[@"y"] doubleValue] - self.logicalClip.origin.y, [r[@"width"] doubleValue], [r[@"height"] doubleValue]);
    CGFloat radius = [entry[@"radius"] doubleValue];
    [blocked addObject:[NSBezierPath bezierPathWithRoundedRect:hole xRadius:radius yRadius:radius]];
    if ([entry[@"inputOnly"] boolValue]) continue;
    if ([entry[@"dim"] doubleValue] > 0) { if (NSIntersectsRect(self.clip.bounds,hole)) dim = MAX(dim,[entry[@"dim"] doubleValue]); continue; }
    CGPathRef cut = CGPathCreateWithRoundedRect(NSRectToCGRect(hole), radius, radius, NULL);
    CGPathRef next = CGPathCreateCopyBySubtractingPath(path,cut,false); CGPathRelease(cut); CGPathRelease(path); path = next;
  }
  self.clip.blocked = blocked;
  CAShapeLayer *mask = [CAShapeLayer layer]; mask.path = path; self.clip.layer.mask = mask; CGPathRelease(path);
  self.shade.frame = self.clip.bounds; self.shade.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:dim].CGColor;
}
- (void)dispose {
  [NSNotificationCenter.defaultCenter removeObserver:self];
  [self.web stopLoading]; self.web.navigationDelegate = nil;
  [self.web.configuration.userContentController removeScriptMessageHandlerForName:@"kybern"];
  [self.web.configuration.userContentController removeScriptMessageHandlerForName:@"kybernFrame" contentWorld:[WKContentWorld worldWithName:@"KybernPreview"]];
  [self.clip removeFromSuperview]; self.web = nil; self.clip = nil;
}
@end

void kybern_web_init(void (*callback)(void)) { events = [NSMutableArray new]; hosts = [NSMutableDictionary new]; occlusions = [NSMutableDictionary new]; signalJS = callback; }
const char *kybern_web_next(void) {
  @synchronized(events) { if (!events.count) return NULL; lastEvent = events.firstObject; [events removeObjectAtIndex:0]; return lastEvent.UTF8String; }
}
void kybern_web_command(const char *json) {
  NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (!cmd) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSString *identifier = cmd[@"id"], *op = cmd[@"op"];
    if ([op isEqual:@"capture"]) { pointerCaptured = [cmd[@"active"] boolValue]; return; }
    if ([op isEqual:@"occlusion"]) {
      if ([cmd[@"rect"] isKindOfClass:NSDictionary.class]) occlusions[cmd[@"layer"]] = cmd; else [occlusions removeObjectForKey:cmd[@"layer"]];
      for (KybernWebHost *host in hosts.allValues) [host mask]; return;
    }
    KybernWebHost *host = hosts[identifier];
    if ([op isEqual:@"create"]) {
      if (!keyMonitor) keyMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        if (!(event.modifierFlags & NSEventModifierFlagCommand) || event.isARepeat) return event;
        NSString *key = event.charactersIgnoringModifiers.lowercaseString;
        if ([key isEqual:@"\uf700"]) key = @"up";
        BOOL alt = (event.modifierFlags & NSEventModifierFlagOption) != 0;
        if (!(alt ? [key isEqual:@"p"] : [@[@"l",@"r",@"n",@"b",@"k",@"j",@"[",@"]",@"up",@",",@"\\"] containsObject:key])) return event;
        for (KybernWebHost *h in hosts.allValues) {
          NSResponder *responder = event.window.firstResponder;
          if ([responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:h.web]) {
            emit(@{@"id":h.identifier,@"type":@"shortcut",@"key":key,@"modifiers":@{@"cmd":@YES,@"ctrl":@((event.modifierFlags & NSEventModifierFlagControl)!=0),@"alt":@(alt),@"shift":@((event.modifierFlags & NSEventModifierFlagShift)!=0)}}); return nil;
          }
        }
        return event;
      }];
      NSUInteger count = 0; for (KybernWebHost *h in hosts.allValues) if ([h.category isEqual:@"preview"]) count++;
      if (host || ([cmd[@"category"] isEqual:@"preview"] && count >= 2)) { emit(@{@"id":identifier,@"type":@"failed",@"message":@"Close another preview and try again."}); return; }
      NSWindow *window = nil; for (NSWindow *w in NSApp.windows) if (w.canBecomeKeyWindow) { window = w; break; }
      if (!window) { emit(@{@"id":identifier,@"type":@"failed",@"message":@"The preview window is unavailable."}); return; }
      host = [KybernWebHost new]; host.identifier = identifier; host.category = cmd[@"category"]; host.generation = cmd[@"generation"];
      host.allowedOrigins = cmd[@"allowedOrigins"];
      host.wrapperHTML = cmd[@"html"]; host.wrapperURL = [NSURL URLWithString:[@"tauri://localhost/embedded/" stringByAppendingString:[identifier stringByAddingPercentEncodingWithAllowedCharacters:NSCharacterSet.URLPathAllowedCharacterSet]]];
      WKWebViewConfiguration *config = [WKWebViewConfiguration new]; config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
      [config setURLSchemeHandler:host forURLScheme:@"tauri"];
      config.preferences.javaScriptCanOpenWindowsAutomatically = NO;
      [config.userContentController addScriptMessageHandler:host name:@"kybern"];
      WKContentWorld *world = [WKContentWorld worldWithName:@"KybernPreview"];
      [config.userContentController addScriptMessageHandler:host contentWorld:world name:@"kybernFrame"];
      NSString *frameScript = @"if(window.parent!==window&&window.parent===window.top){const send=()=>window.webkit.messageHandlers.kybernFrame.postMessage('frame');send();addEventListener('popstate',send);addEventListener('hashchange',send)}";
      [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:frameScript injectionTime:WKUserScriptInjectionTimeAtDocumentEnd forMainFrameOnly:NO inContentWorld:world]];
      host.clip = [KybernWebClip new]; host.clip.wantsLayer = YES; host.clip.layer.masksToBounds = YES; host.clip.hidden = YES;
      host.web = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:config]; host.web.navigationDelegate = host;
      host.shade = [KybernWebShade new]; host.shade.wantsLayer = YES;
      [host.clip addSubview:host.web]; [host.clip addSubview:host.shade]; [window.contentView addSubview:host.clip]; hosts[identifier] = host;
      for (NSNotificationName name in @[NSWindowDidChangeOcclusionStateNotification, NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification]) [NSNotificationCenter.defaultCenter addObserver:host selector:@selector(visibility) name:name object:window];
      [host.web loadRequest:[NSURLRequest requestWithURL:host.wrapperURL]];
      emit(@{@"id":identifier,@"generation":host.generation,@"type":@"created",@"windowNumber":@(window.windowNumber)}); return;
    }
    if (!host) return;
    if ([op isEqual:@"hide"]) { host.placed = NO; [host visibility]; return; }
    if ([op isEqual:@"navigate"]) {
      NSURL *url = [NSURL URLWithString:cmd[@"url"]];
      if (![host allowsURL:url]) return;
      NSData *literal = [NSJSONSerialization dataWithJSONObject:@[url.absoluteString] options:NSJSONWritingFragmentsAllowed error:nil];
      NSString *array = [[NSString alloc] initWithData:literal encoding:NSUTF8StringEncoding];
      NSString *script = [NSString stringWithFormat:host.childFrame ? @"{const url=(%@)[0];if(location.href===url)location.reload();else location.replace(url)}" : @"document.querySelector('iframe').src=(%@)[0]", array];
      // DOM is shared, JavaScript globals are not. Page code cannot replace this command.
      [host.web evaluateJavaScript:script inFrame:host.childFrame inContentWorld:[WKContentWorld worldWithName:@"KybernPreview"] completionHandler:^(id value, NSError *error) {}];
      return;
    }
    if ([op isEqual:@"action"]) {
      if ([cmd[@"action"] isEqual:@"stop"]) { [host.web stopLoading]; return; }
      NSDictionary *scripts = @{@"back":@"history.back()",@"forward":@"history.forward()",@"reload":@"location.reload()",@"stop":@"window.stop()"};
      NSString *script = scripts[cmd[@"action"]];
      if (script && host.childFrame) [host.web evaluateJavaScript:script inFrame:host.childFrame inContentWorld:[WKContentWorld worldWithName:@"KybernPreview"] completionHandler:^(id value, NSError *error) {}];
      return;
    }
    if ([op isEqual:@"destroy"]) { [host dispose]; [hosts removeObjectForKey:identifier]; if (!hosts.count && keyMonitor) { [NSEvent removeMonitor:keyMonitor]; keyMonitor = nil; } emit(@{@"id":identifier,@"generation":host.generation,@"type":@"destroyed"}); return; }
    if ([op isEqual:@"place"]) {
      NSView *content = host.clip.superview;
      double x = [cmd[@"x"] doubleValue], y = [cmd[@"y"] doubleValue], width = [cmd[@"width"] doubleValue], height = [cmd[@"height"] doubleValue];
      host.clip.frame = NSMakeRect(x, content.isFlipped ? y : content.bounds.size.height - y - height, width, height);
      host.clip.layer.cornerRadius = [cmd[@"radius"] doubleValue];
      host.logicalClip = NSMakeRect(x,y,width,height); host.layer = [cmd[@"layer"] integerValue]; [host mask];
      host.web.frame = NSMakeRect([cmd[@"offsetX"] doubleValue], [cmd[@"offsetY"] doubleValue], [cmd[@"logicalWidth"] doubleValue], [cmd[@"logicalHeight"] doubleValue]);
      // WKWebView magnification does not change the layout viewport. The wrapper
      // sizes the iframe and scales its rendering, matching Tauri device mode.
      NSString *layout = cmd[@"layout"];
      if (layout) [host.web evaluateJavaScript:layout completionHandler:nil];
      host.placed = [cmd[@"visible"] boolValue] && width > 0 && height > 0; [host visibility]; return;
    }
    if ([op isEqual:@"post"]) { [host.web evaluateJavaScript:cmd[@"script"] completionHandler:nil]; return; }
    if ([op isEqual:@"focus"]) [host.clip.window makeFirstResponder:host.web];
  });
}
