#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
static void (*signalJS)(void);
static NSMutableArray<NSString *> *queue;
static NSString *last;
static void emit(NSDictionary *event) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  @synchronized(queue) { [queue addObject:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]]; }
  if (signalJS) signalJS();
}
@interface KybernNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation KybernNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))done {
  if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
    NSString *identifier = response.notification.request.identifier;
    dispatch_async(dispatch_get_main_queue(), ^{
      [NSApp activateIgnoringOtherApps:YES];
      for (NSWindow *w in NSApp.windows) { if (w.canBecomeKeyWindow) { [w makeKeyAndOrderFront:nil]; break; } }
      emit(@{@"click":identifier});
    });
  }
  done();
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))done {
  done(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound | UNNotificationPresentationOptionList);
}
@end
static KybernNotificationDelegate *delegate;
int kybern_notifications_init(void (*callback)(void)) {
  if (![[NSBundle mainBundle].bundleIdentifier isEqualToString:@"dev.kybern.gpuix"]) return 0;
  queue = [NSMutableArray new]; signalJS = callback;
  delegate = [KybernNotificationDelegate new];
  [UNUserNotificationCenter currentNotificationCenter].delegate = delegate;
  return 1;
}
const char *kybern_notifications_next(void) {
  @synchronized(queue) { if (!queue.count) return NULL; last = queue.firstObject; [queue removeObjectAtIndex:0]; return last.UTF8String; }
}
void kybern_notifications_command(const char *json) {
  NSDictionary *cmd = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  NSNumber *token = cmd[@"token"];
  UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
  center.delegate = delegate;
  void (^status)(void) = ^{ [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *s) {
    NSString *value = @"not-determined";
    if (s.authorizationStatus == UNAuthorizationStatusDenied) value = @"denied";
    else if (s.authorizationStatus == UNAuthorizationStatusAuthorized || s.authorizationStatus == UNAuthorizationStatusProvisional) value = @"granted";
    emit(@{@"token":token, @"value":value});
  }]; };
  if ([cmd[@"op"] isEqual:@"status"]) { status(); return; }
  if ([cmd[@"op"] isEqual:@"permission"]) {
    [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {
      if (error) emit(@{@"token":token,@"error":error.localizedDescription}); else status();
    }]; return;
  }
  UNMutableNotificationContent *content = [UNMutableNotificationContent new];
  content.title = cmd[@"title"]; content.body = cmd[@"body"]; content.sound = [UNNotificationSound defaultSound];
  UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:cmd[@"id"] content:content trigger:nil];
  [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
    if (error) emit(@{@"token":token,@"error":error.localizedDescription}); else emit(@{@"token":token,@"value":@YES});
  }];
}
